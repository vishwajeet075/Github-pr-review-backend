const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { OpenAI } = require('openai');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();

// Improved error logging
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => logger.info('MongoDB connected successfully'))
.catch((err) => logger.error('MongoDB connection error:', err));

// MongoDB session store setup
const store = new MongoDBStore({
  uri: process.env.MONGODB_URI,
  collection: 'sessions',
  expires: 1000 * 60 * 60 * 24, // 24 hours
});

store.on('error', (error) => {
  logger.error('Session store error:', error);
});

// Middleware to check MongoDB connection before each request
app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    logger.error('MongoDB is not connected');
    return res.status(500).json({ error: 'Database connection error' });
  }
  next();
});

// Use session middleware with MongoDB store
app.use(session({
  secret: process.env.SESSION_SECRET || 'a-very-long-and-random-secret-key',
  resave: false,
  saveUninitialized: false,
  store: store,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 // 24 hours
  }
}));

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://github-pr-review.netlify.app',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
}));

app.use(express.json());

// GitHub OAuth endpoint
app.post('/github-oauth', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'GitHub code is required' });
  }

  try {
    const response = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      },
      {
        headers: {
          Accept: 'application/json',
        },
      }
    );

    const accessToken = response.data.access_token;

    if (!accessToken) {
      logger.error('No access token received from GitHub');
      return res.status(400).json({ error: 'Failed to obtain access token' });
    }

    // Store the token in the session
    req.session.githubAccessToken = accessToken;
    
    // Save session explicitly
    req.session.save((err) => {
      if (err) {
        logger.error('Error saving session:', err);
        return res.status(500).json({ error: 'Error saving session' });
      }
      logger.info('GitHub access token stored in session');
      res.json({ access_token: accessToken });
    });
  } catch (error) {
    logger.error('Error fetching GitHub token:', error);
    res.status(500).json({ error: 'Error fetching GitHub token' });
  }
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// GitHub webhook handler for pull request events
app.post('/webhook', async (req, res) => {
  const { action, pull_request } = req.body;

  if (!req.session.githubAccessToken) {
    logger.error('GitHub access token not found in session');
    return res.status(401).json({ error: 'GitHub access token not found in session' });
  }

  if (action === 'opened') {
    const prData = {
      prNumber: pull_request.number,
      prTitle: pull_request.title,
      prBody: pull_request.body,
      repoOwner: pull_request.base.repo.owner.login,
      repoName: pull_request.base.repo.name,
      changedFiles: pull_request.changed_files,
    };

    try {
      const filesResponse = await axios.get(`${pull_request.url}/files`, {
        headers: { Authorization: `Bearer ${req.session.githubAccessToken}` },
      });

      const changedFiles = filesResponse.data;

      // Review the PR with AI
      const reviewResult = await reviewPRWithAI(changedFiles);

      // Post the AI's feedback as a comment on the PR
      await postReviewComment(prData, reviewResult, req.session.githubAccessToken);

      res.status(200).json({ message: 'PR reviewed successfully' });
    } catch (error) {
      logger.error('Error processing webhook:', error);
      res.status(500).json({ error: 'Error processing webhook' });
    }
  } else {
    res.status(200).json({ message: 'Webhook received, no action taken' });
  }
});

// Function to interact with OpenAI API
async function reviewPRWithAI(changedFiles) {
  const codeReviewPrompts = changedFiles.map(
    (file) => `Review the following changes in ${file.filename}: ${file.patch}`
  );

  try {
    const responses = await Promise.all(
      codeReviewPrompts.map(async (prompt) => {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: prompt }],
        });
        return completion.choices[0].message.content.trim();
      })
    );

    return responses;
  } catch (error) {
    logger.error('Error communicating with OpenAI:', error);
    throw error;
  }
}

// Function to post the review comment on the PR
async function postReviewComment(prData, reviewResult, accessToken) {
  const commentBody = reviewResult.join('\n\n');

  try {
    await axios.post(
      `https://api.github.com/repos/${prData.repoOwner}/${prData.repoName}/issues/${prData.prNumber}/comments`,
      {
        body: commentBody,
      },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    logger.info('Review comment posted successfully.');
  } catch (error) {
    logger.error('Error posting review comment:', error);
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', mongoConnection: mongoose.connection.readyState });
});



app.post('/check-webhook', async (req, res) => {
  const { repoOwner, repoName, webhookUrl } = req.body;
  
  if (!req.session.githubAccessToken) {
    logger.error('GitHub access token not found in session');
    return res.status(401).json({ error: 'GitHub access token not found in session' });
  }

  try {
    const response = await axios.get(
      `https://api.github.com/repos/${repoOwner}/${repoName}/hooks`,
      {
        headers: {
          Authorization: `Bearer ${req.session.githubAccessToken}`,
          Accept: 'application/vnd.github.v3+json'
        }
      }
    );

    const webhookExists = response.data.some(hook => hook.config.url === webhookUrl);
    res.json({ webhookExists });
  } catch (error) {
    logger.error('Error checking existing webhooks:', error.response ? error.response.data : error);
    res.status(error.response ? error.response.status : 500).json({ error: 'Error checking webhooks' });
  }
});


// Start the server
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
});


app.use((req, res, next) => {
  if (!req.session.githubAccessToken && req.headers.authorization) {
    const token = req.headers.authorization.split(' ')[1];
    req.session.githubAccessToken = token;
  }
  next();
});


// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'An unexpected error occurred' });
});