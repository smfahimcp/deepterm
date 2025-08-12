import express from 'express';
import cors from 'cors';
import { completion, createChatSession, fetchHistoryMessages } from './deepterm-core.js';

const app = express();

app.use(cors());
app.use(express.json());

const sendError = (res, code, message) => {
  res.status(code).json({ error: message });
};

app.post('/completion', async (req, res) => {
  const { token, prompt, sessid = "", stream = true } = req.body;

  if (!token || !prompt) {
    return sendError(res, 400, 'Missing "token" or "prompt"');
  }

  let CHAT_SESSION_ID;
  try {
    if (!sessid) {
      const CHAT_SESSION = await createChatSession(token);
      if (!CHAT_SESSION?.data?.biz_data?.id) {
        throw new Error('Failed to create chat session');
      }
      CHAT_SESSION_ID = CHAT_SESSION.data.biz_data.id;
      console.log(`[SESSION] New session created: ${CHAT_SESSION_ID}`);
    } else {
      CHAT_SESSION_ID = sessid;
      console.log(`[SESSION] Using existing session: ${CHAT_SESSION_ID}`);
    }

    const history = await fetchHistoryMessages(token, CHAT_SESSION_ID);
    const lastMsg = history?.data?.biz_data?.chat_messages?.slice(-1)[0] || null;
    const parentMessageId = lastMsg?.message_id ?? null;

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      for await (const chunk of completion(token, prompt, CHAT_SESSION_ID, parentMessageId, true)) {
        res.write(`data: ${chunk}\n\n`);
      }
      res.write('event: end\ndata: [DONE]\n\n');
      res.end();
    } else {
      const resultData = completion(token, prompt, CHAT_SESSION_ID, parentMessageId, false);
      const { value: result } = await resultData.next();
      res.json({ result });
    }
  } catch (err) {
    console.error(`[ERROR] ${err.message || err}`);
    sendError(res, 500, 'Internal server error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🧠 DeepSeek API server listening on port ${PORT}`);
});
