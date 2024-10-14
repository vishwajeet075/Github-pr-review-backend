const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');


require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());


let githubToken = null;

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 5000; // 5 seconds

async function retryableRequest(config, retries = MAX_RETRIES, delay = INITIAL_RETRY_DELAY) {
  try {
    const response = await axios(config);
    return response;
  } catch (error) {
    if (retries > 0 && error.response && error.response.status === 503) {
      console.log(`Request failed. Retrying in ${delay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryableRequest(config, retries - 1, delay * 2);
    }
    throw error;
  }
}


app.post('/github-oauth', async (req, res) => {
  const { code } = req.body;

  try {
    const response = await axios.post('https://github.com/login/oauth/access_token', {
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }, {
      headers: {
        Accept: 'application/json',
      },
    });

    githubToken = response.data.access_token;
    res.json({ success: true });
  } catch (error) {
    console.error('Error during GitHub OAuth:', error);
    res.status(500).json({ success: false, error: 'Failed to authenticate with GitHub' });
  }
});

app.post('/create-webhook', async (req, res) => {
  const { owner, repo } = req.body;

  try {
    await axios.post(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
      name: 'web',
      active: true,
      events: ['pull_request'],
      config: {
        url: 'https://github-pr-review-backend.onrender.com/webhook',
        content_type: 'json',
        secret: process.env.WEBHOOK_SECRET,
      },
    }, {
      headers: {
        Authorization: `token ${githubToken}`,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error creating webhook:', error);
    res.status(500).json({ success: false, error: 'Failed to create webhook' });
  }
});

app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const payload = JSON.stringify(req.body);
  const secret = process.env.WEBHOOK_SECRET;

  const computedSignature = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;

  if (computedSignature !== signature) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (req.body.action === 'opened' || req.body.action === 'synchronize') {
    const prNumber = req.body.pull_request.number;
    const owner = req.body.repository.owner.login;
    const repo = req.body.repository.name;

    try {
      const prResponse = await axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
        headers: { Authorization: `token ${githubToken}` },
      });

      const prDiff = await axios.get(prResponse.data.diff_url, {
        headers: { Authorization: `token ${githubToken}` },
      });

      // Prepare the prompt for the CodeReviewer model
      const aiPrompt = `Review the following code changes and provide feedback:

${prDiff.data}

Please provide:
1. A brief summary of the changes
2. Any potential issues or improvements
3. A suggested title for the pull request`;

      // CodeReviewer model API call
      const aiResponse = await retryableRequest({
        method: 'post',
        url: 'https://api-inference.huggingface.co/models/microsoft/codereviewer',
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        data: {
          inputs: aiPrompt,
        },
      });

      let reviewComment = '';
      if (aiResponse.data && aiResponse.data[0] && aiResponse.data[0].generated_text) {
        reviewComment = aiResponse.data[0].generated_text.trim();
      } else {
        console.error('Unexpected AI response format:', aiResponse.data);
        reviewComment = 'Unable to generate AI review at this time.';
      }

      // Extract title from the AI response (assuming it's the last line)
      const lines = reviewComment.split('\n');
      const prTitle = lines[lines.length - 1].startsWith('Title:') 
        ? lines[lines.length - 1].slice(6).trim() 
        : 'AI Review: Code Changes';

      // Update PR title and description
      await axios.patch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
        title: prTitle,
        body: reviewComment,
      }, {
        headers: { Authorization: `token ${githubToken}` },
      });

      // Post a comment with the full AI review
      await axios.post(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
        body: `AI Code Review:\n\n${reviewComment}`,
      }, {
        headers: { Authorization: `token ${githubToken}` },
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error processing webhook:', error);
      res.status(500).json({ success: false, error: 'Failed to process webhook' });
    }
  } else {
    res.json({ success: true, message: 'Event ignored' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));