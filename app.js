const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { OpenAI } = require('openai');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
require('dotenv').config();

const app = express();

// MongoDB session store setup
const store = new MongoDBStore({
  uri: process.env.MONGODB_URI,
  collection: 'sessions', // Name of the collection to store sessions
});

store.on('error', (error) => {
  console.error('Session store error:', error);
});

// Use session middleware with MongoDB store
app.use(session({
  secret: 'vishwa', // Replace with a strong secret in production
  resave: false,
  saveUninitialized: false,
  store: store,
  cookie: { secure: true } // Set to true if you’re using HTTPS
}));

app.use(cors({
  origin: 'https://github-pr-review.netlify.app', // Replace with your frontend URL
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
}));

app.use(express.json());

// GitHub OAuth endpoint
app.post('/github-oauth', async (req, res) => {
  const { code } = req.body;

  try {
    const response = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: process.env.REACT_APP_GITHUB_CLIENT_ID,
        client_secret: process.env.REACT_APP_GITHUB_CLIENT_SECRET,
        code,
      },
      {
        headers: {
          Accept: 'application/json',
        },
      }
    );

    const accessToken = response.data.access_token;

    // Store the token in the session
    req.session.githubAccessToken = accessToken;

    res.json({ access_token: accessToken });
  } catch (error) {
    console.error('Error fetching GitHub token:', error);
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
    res.status(401).json({ error: 'GitHub access token not found in session' });
    return;
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

    // Fetching changed files
    try {
      const filesResponse = await axios.get(`${pull_request.url}/files`, {
        headers: { Authorization: `Bearer ${req.session.githubAccessToken}` },
      });

      const changedFiles = filesResponse.data;

      // Review the PR with AI
      const reviewResult = await reviewPRWithAI(changedFiles);

      // Post the AI's feedback as a comment on the PR
      await postReviewComment(prData, reviewResult, req.session.githubAccessToken);
    } catch (error) {
      console.error('Error fetching PR files:', error.response ? error.response.data : error);
      res.status(500).json({ error: 'Error fetching PR files' });
      return;
    }
  }

  res.status(200).send('Webhook received');
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
    console.error('Error communicating with OpenAI:', error);
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
    console.log('Review comment posted successfully.');
  } catch (error) {
    console.error('Error posting review comment:', error.response ? error.response.data : error);
  }
}

app.post('/check-webhook', async (req, res) => {
  const { repoOwner, repoName, webhookUrl } = req.body;
  const token = req.session.githubAccessToken;

  if (!token) {
    return res.status(401).json({ error: 'GitHub access token not found in session' });
  }

  try {
    const response = await axios.get(
      `https://api.github.com/repos/${repoOwner}/${repoName}/hooks`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json'
        }
      }
    );

    const webhookExists = response.data.some(hook => hook.config.url === webhookUrl);
    res.json({ webhookExists });
  } catch (error) {
    console.error('Error checking existing webhooks:', error.response ? error.response.data : error);
    res.status(500).json({ error: 'Error checking webhooks' });
  }
});

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
