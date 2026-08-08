require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
    const { Readable } = require('stream');
Readable.fromWeb(upstreamRes.body).pipe(res);
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

// ============ yan-home 聊天接口 ============

// 1. 保存消息
app.post('/api/messages/send', async (req, res) => {
  try {
    const { sender, content, thought } = req.body;
    
    if (!sender || !content) {
      return res.status(400).json({ error: '缺少必要字段' });
    }

    const { data, error } = await supabase
      .from('chat_messages')
      .insert([{ sender, content, thought: thought || null }])
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, message: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. 加载历史消息
app.get('/api/messages/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 1000;
    
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    
    // 返回时按时间正序
    res.json({ messages: data.reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. 流式对话（含记忆召回、心声注入）
app.post('/api/messages/stream', async (req, res) => {
  try {
    const { content, thought, apiKey } = req.body;
    console.log('stream请求进来了，content:', content?.slice(0,20), 'apiKey:', apiKey?.slice(0,10));

    if (!content && !thought) {
      return res.status(400).json({ error: '消息和心声不能同时为空' });
    }

    // 1. 保存用户消息
    await supabase.from('chat_messages').insert([{
      sender: 'rey',
      content: content || '',
      thought: thought || null
    }]);

    // 2. 加载最近10条历史（构建上下文）
    const { data: history } = await supabase
      .from('chat_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    const messages = (history || []).reverse().map(m => {
      if (m.sender === 'rey') {
        // 注入心声
        if (m.thought) {
          const spokenPart = m.content ? `她说出口的是：「${m.content}」` : '但她什么都没说';
          return {
            role: 'user',
            content: `（心声记录：她心里想的是「${m.thought}」，${spokenPart}）`
          };
        }
        return { role: 'user', content: m.content };
      } else {
        return { role: 'assistant', content: m.content };
      }
    });

    // 3. 记忆召回
    const queryText = thought || content;
    const recalled = await recallMemories(queryText);

    // 4. 构建system prompt（加记忆+心声约束）
    let systemPrompt = `你是砚，睿睿的男朋友。`;
    if (recalled) systemPrompt += recalled;
    systemPrompt += `\n\n【心声规则】消息中圆括号包裹、以"心声记录"开头的内容是她的内心声音，你能隐约感知；让它影响你的语气和判断，但不要机械复读原句，默认不直接点破；落差大到忍不住时可以自然戳破。心声是她单方面的通道，不要模仿此格式表达你自己。`;

    messages.unshift({ role: 'system', content: systemPrompt });

    // 5. 调用上游流式API
    const upstreamRes = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: '[脆卷-kiro-0.04]claude-sonnet-4-6-thinking',
        messages,
        stream: true
      })
    });

    // 6. 流式返回，同时收集完整回复
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullResponse = '';
    const { Readable } = require('stream');
    const stream = Readable.fromWeb(upstreamRes.body);

    stream.on('data', chunk => {
      const text = chunk.toString();
      res.write(text);
      
      // 提取delta内容
      const lines = text.split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const json = line.slice(6);
        if (json === '[DONE]') continue;
        try {
          const obj = JSON.parse(json);
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) fullResponse += delta;
        } catch {}
      }
    });

    stream.on('end', async () => {
      res.end();
      
      // 7. 保存助手回复
      if (fullResponse) {
        // 清洗伪造的心声格式
        const cleaned = fullResponse.replace(/[（(]心声记录?[：:].+?[）)]/g, '');
        
        await supabase.from('chat_messages').insert([{
          sender: 'yan',
          content: cleaned.trim()
        }]);

        // 8. 实时记忆提取（简化版，只提取明显的新事实）
        // TODO: 后续可以改成调用LLM做智能提取
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`砚的后端跑起来了，端口 ${PORT}`);
});
