require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const UPSTREAM = process.env.UPSTREAM_URL || ' https://shufulei.net/v1'; 
const SILICONFLOW_KEY = process.env.SILICONFLOW_KEY;
const EMBED_MODEL = 'BAAI/bge-large-zh-v1.5';

// 健康检查
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '砚的后端运行中' });
});

// 获取embedding
async function getEmbedding(text) {
  const res = await fetch(' https://api.siliconflow.cn/v1/embeddings',  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SILICONFLOW_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text, encoding_format: 'float' })
  });
  const data = await res.json();
  return data.data?.[0]?.embedding || null;
}

// 召回记忆
async function recallMemories(query, topK = 6) {
  const embedding = await getEmbedding(query);
  if (!embedding) return '';
  const { data } = await supabase.rpc('search_memories', {
    query_embedding: JSON.stringify(embedding),
    match_count: topK
  });
  if (!data || data.length === 0) return '';
  const filtered = data.filter(r => r.final_score > 0.35);
  if (filtered.length === 0) return '';
  const lines = filtered.map(r => `[${r.source === 'event' ? '事件' : '事实'}] ${r.content}`);
  return '\n\n【相关记忆浮现】\n' + lines.join('\n');
}

// 对话接口——代理到上游并注入记忆
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const body = req.body;
    const messages = body.messages || [];

    // 取最后一条用户消息做记忆召回
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const recalled = lastUser ? await recallMemories(lastUser.content) : '';

    if (recalled) {
      const sysIdx = messages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        messages[sysIdx] = { ...messages[sysIdx], content: messages[sysIdx].content + recalled };
      } else {
        messages.unshift({ role: 'system', content: recalled });
      }
    }

    const apiKey = req.headers['authorization'];
    const upstreamRes = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      body: JSON.stringify({ ...body, messages })
    });

    const contentType = upstreamRes.headers.get('content-type') || '';
    res.status(upstreamRes.status);
    res.set('Content-Type', contentType);

    // 流式透传
    upstreamRes.body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 透传其他接口（模型列表等）
app.all('/v1/*splat', async (req, res) => {
  try {
    const path = req.path;
    const upstreamRes = await fetch(`${UPSTREAM}${path}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers['authorization'] || ''
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
    });
    const data = await upstreamRes.json();
    res.status(upstreamRes.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`砚的后端跑起来了，端口 ${PORT}`);
});