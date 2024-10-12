const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { OpenAI } = require('openai');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
const mongoose = require('mongoose');
const crypto = require('crypto');
require('dotenv').config();

const app = express();


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


mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => logger.info('MongoDB connected successfully'))
.catch((err) => logger.error('MongoDB connection error:', err));

const store = new MongoDBStore({
  uri: process.env.MONGODB_URI,
  collection: 'sessions',
  expires: 1000 * 60 * 60 * 24, // 24 hours
});

store.on('error', (error) => {
  logger.error('Session store error:', error);
});

// Webhook schema
const WebhookSchema = new mongoose.Schema({
  repoOwner: String,
  repoName: String,
  webhookId: Number,
  secret: String
});

const Webhook = mongoose.model('Webhook', WebhookSchema);

app.use(session({
  secret: process.env.SESSION_SECRET || 'a-very-long-and-random-secret-key',
  resave: false,
  saveUninitialized: false,
  store: store,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24, // 24 hours
    sameSite: 'none'
  }
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://github-pr-review.netlify.app',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
}));

app.use(express.json());

// Middleware to validate GitHub token
const validateGitHubToken = async (req, res, next) => {
  const token = req.session.githubAccessToken;
  if (!token) {
    return res.status(401).json({ error: 'No GitHub token found' });
  }
  try {
    const response = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.status === 200) {
      req.githubToken = token;
      next();
    } else {
      res.status(401).json({ error: 'Invalid GitHub token' });
    }
  } catch (error) {
    logger.error('Error validating GitHub token:', error);
    res.status(401).json({ error: 'Invalid GitHub token' });
  }
};

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

    req.session.githubAccessToken = accessToken;
    
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

// Webhook creation endpoint
app.post('/create-webhook', validateGitHubToken, async (req, res) => {
  const { repoOwner, repoName } = req.body;
  const webhookSecret = crypto.randomBytes(20).toString('hex');

  try {
    const response = await axios.post(
      `https://api.github.com/repos/${repoOwner}/${repoName}/hooks`,
      {
        name: 'web',
        active: true,
        events: ['pull_request'],
        config: {
          url: `https://github-pr-review-backend.onrender.com/webhook`,
          content_type: 'json',
          secret: webhookSecret,
          insecure_ssl: '0'
        }
      },
      {
        headers: {
          Authorization: `Bearer ${req.githubToken}`,
          Accept: 'application/vnd.github.v3+json'
        }
      }
    );

    const newWebhook = new Webhook({
      repoOwner,
      repoName,
      webhookId: response.data.id,
      secret: webhookSecret
    });
    await newWebhook.save();

    res.json({ message: 'Webhook created successfully', id: response.data.id });
  } catch (error) {
    logger.error('Error creating webhook:', error.response ? error.response.data : error);
    res.status(error.response ? error.response.status : 500).json({ 
      error: 'Error creating webhook',
      details: error.response ? error.response.data : error.message
    });
  }
});

// Updated webhook handler
app.post('/webhook', async (req, res) => {
  const githubSignature = req.headers['x-hub-signature-256'];
  const { repository, pull_request } = req.body;

  // Verify the webhook signature
  const webhook = await Webhook.findOne({ 
    repoOwner: repository.owner.login, 
    repoName: repository.name 
  });

  if (!webhook) {
    logger.error('Webhook not found for repository');
    return res.status(404).send('Not found');
  }

  const hmac = crypto.createHmac('sha256', webhook.secret);
  const calculatedSignature = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');

  if (calculatedSignature !== githubSignature) {
    logger.error('Invalid webhook signature');
    return res.status(401).send('Unauthorized');
  }

  // Process the webhook payload
  if (req.body.action === 'opened') {
    const prData = {
      prNumber: pull_request.number,
      prTitle: pull_request.title,
      prBody: pull_request.body,
      repoOwner: repository.owner.login,
      repoName: repository.name,
      changedFiles: pull_request.changed_files,
    };

    try {
      const filesResponse = await axios.get(`${pull_request.url}/files`, {
        headers: { Authorization: `Bearer ${webhook.secret}` },
      });

      const changedFiles = filesResponse.data;

      // Review the PR with AI
      const reviewResult = await reviewPRWithAI(changedFiles);

      // Post the AI's feedback as a comment on the PR
      await postReviewComment(prData, reviewResult, webhook.secret);

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





// Start the server
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
});



// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'An unexpected error occurred' });
});