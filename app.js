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

      // Hugging Face Inference API call with retry mechanism
      const aiResponse = await retryableRequest({
        method: 'post',
        url: 'https://api-inference.huggingface.co/models/facebook/bart-large-cnn',
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        data: {
          inputs: `Summarize the following code changes and provide a review:\n\n${prDiff.data}`,
        },
      });

      let reviewComment = '';
      if (aiResponse.data && aiResponse.data[0] && aiResponse.data[0].summary_text) {
        reviewComment = aiResponse.data[0].summary_text.trim();
      } else {
        console.error('Unexpected AI response format:', aiResponse.data);
        reviewComment = 'Unable to generate AI review at this time.';
      }

      // Generate a simple title based on the first line of the review
      const prTitle = `AI Review: ${reviewComment.split('\n')[0].slice(0, 50)}...`;

      // Update PR title and description
      await axios.patch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
        title: prTitle,
        body: reviewComment,
      }, {
        headers: { Authorization: `token ${githubToken}` },
      });

      // Post a comment with the full AI review
      await axios.post(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
        body: `AI Review:\n\n${reviewComment}`,
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