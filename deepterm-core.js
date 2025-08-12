import fs from 'fs';
import { Buffer } from 'buffer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';
import FormData from 'form-data';

const wasmFile = './deepseek.wasm';
const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dirname, wasmFile);
let wasmBytes;
try {
  wasmBytes = fs.readFileSync(wasmPath);
} catch (e) {
  wasmBytes = null;
}

let wasmInstance, wasmExports, memory, malloc, addToStackPointer;

async function initWasm() {
  if (wasmInstance) return;
  if (!wasmBytes) throw new Error(`WASM file not found at ${wasmPath}`);

  try {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    wasmInstance = instance;
    wasmExports = instance.exports;
    memory = wasmExports.memory;
    malloc = wasmExports.__wbindgen_malloc || wasmExports.__wbindgen_export_0 || wasmExports.malloc;
    addToStackPointer = wasmExports.__wbindgen_add_to_stack_pointer || wasmExports.add_to_stack_pointer;

    if (typeof malloc !== 'function') {
      throw new Error('WASM allocator (malloc) not found on exports');
    }
    if (typeof addToStackPointer !== 'function') {
      addToStackPointer = null;
    }
  } catch (e) {
    throw new Error(`Failed to initialize WASM: ${e.message || e}`);
  }
}

function alloc_utf8(str) {
  if (typeof TextEncoder === 'undefined') {
    throw new Error('TextEncoder not available');
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  const size = bytes.length;
  const ptr = malloc(size, 1);
  if (!memory || !memory.buffer) throw new Error('WASM memory unavailable');
  const view = new Uint8Array(memory.buffer, ptr, size);
  view.set(bytes);
  return [ptr, size];
}

export async function solvePow(challenge, salt, expireAt, difficulty) {
  await initWasm();

  const prefix = `${salt}_${expireAt}_`;

  const [challengePtr, challengeLen] = alloc_utf8(challenge);
  const [prefixPtr, prefixLen] = alloc_utf8(prefix);

  let stackPtr = 0;
  let usedStackPointer = false;
  if (addToStackPointer) {
    stackPtr = addToStackPointer(-16);
    usedStackPointer = true;
  } else {
    stackPtr = malloc(16, 1);
  }

  if (typeof wasmExports.wasm_solve !== 'function') {
    throw new Error('wasm_solve not found in wasm exports');
  }

  wasmExports.wasm_solve(
    stackPtr,
    challengePtr,
    challengeLen,
    prefixPtr,
    prefixLen,
    difficulty
  );

  const view = new DataView(memory.buffer, stackPtr, 16);
  const found = view.getInt32(0, true);
  const answer = view.getFloat64(8, true);

  if (found === 0) {
    throw new Error('POW not found');
  }
  return Math.floor(answer);
}

function isJsonString(str) {
  if (typeof str !== 'string') return false;
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' && parsed !== null;
  } catch (e) {
    return false;
  }
}

function headers(TOKEN) {
  const baseHeaders = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    authorization: `Bearer ${TOKEN}`,
    priority: 'u=1, i',
    'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Brave";v="138"',
    'sec-ch-ua-arch': '"x86"',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-full-version-list': '"Not)A;Brand";v="8.0.0.0", "Chromium";v="138.0.0.0", "Brave";v="138.0.0.0"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-platform-version': '"19.0.0"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'sec-gpc': '1',
    'x-app-version': '20241129.1',
    'x-client-locale': 'en_US',
    'x-client-platform': 'web',
    'x-client-version': '1.3.0-auto-resume'
  };
  return baseHeaders;
}

export async function getCurrentProfile(TOKEN) {
  try {
    const response = await fetch('https://chat.deepseek.com/api/v0/users/current', {
      method: 'GET',
      headers: { ...headers(TOKEN) },
      referrer: 'https://chat.deepseek.com/',
      mode: 'cors',
      credentials: 'include'
    });
    if (!response.ok) return;
    const json = await response.json();
    return json;
  } catch (e) {
    return;
  }
}

export async function deleteAllChatSessions(TOKEN, CHAT_SESSION_ID) {
  try {
    const response = await fetch('https://chat.deepseek.com/api/v0/chat_session/delete_all', {
      method: 'POST',
      headers: { ...headers(TOKEN) },
      referrer: `https://chat.deepseek.com/a/chat/s/${CHAT_SESSION_ID}`,
      mode: 'cors',
      credentials: 'include'
    });
    if (!response.ok) return;
    return await response.json();
  } catch (e) {
    return;
  }
}

export async function getFileUrl(TOKEN, CHAT_SESSION_ID, file_id) {
  try {
    const response = await fetch(`https://chat.deepseek.com/api/v0/file/preview?file_id=file-${file_id}`, {
      method: 'GET',
      headers: { ...headers(TOKEN) },
      referrer: `https://chat.deepseek.com/a/chat/s/${CHAT_SESSION_ID}`,
      mode: 'cors',
      credentials: 'include'
    });
    if (!response.ok) return;
    return await response.json();
  } catch (e) {
    return;
  }
}

export async function uploadFile(TOKEN, CHAT_SESSION_ID, filePath) {
  try {
    const pow = await generatePowHeader(TOKEN, CHAT_SESSION_ID, filePath);

    const form = new FormData();
    const fileName = path.basename(filePath);
    form.append('file', fs.createReadStream(filePath), {
      filename: fileName
    });

    const response = await fetch('https://chat.deepseek.com/api/v0/file/upload_file', {
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        ...headers(TOKEN),
        'x-ds-pow-response': pow,
        'x-thinking-enabled': '0'
      },
      body: form,
      referrer: 'https://chat.deepseek.com/',
      mode: 'cors',
      credentials: 'include'
    });

    if (!response.ok) return;
    return await response.json();
  } catch (e) {
    return;
  }
}

export async function createChatSession(TOKEN) {
  try {
    const response = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
      method: 'POST',
      headers: { ...headers(TOKEN), 'content-type': 'application/json' },
      referrer: 'https://chat.deepseek.com/',
      body: JSON.stringify({ character_id: null }),
      mode: 'cors',
      credentials: 'include'
    });
    if (!response.ok) return;
    return await response.json();
  } catch (e) {
    return;
  }
}

export async function fetchAllChatSessions(TOKEN) {
  try {
    const response = await fetch('https://chat.deepseek.com/api/v0/chat_session/fetch_page', {
      method: 'GET',
      headers: { ...headers(TOKEN) },
      referrer: 'https://chat.deepseek.com/',
      mode: 'cors',
      credentials: 'include'
    });
    if (!response.ok) return;
    return await response.json();
  } catch (e) {
    return;
  }
}

export async function generatePowHeader(TOKEN, CHAT_SESSION_ID, targetPath) {
  try {
    const res = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
      method: 'POST',
      headers: { ...headers(TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ target_path: targetPath })
    });

    if (!res.ok) return;
    const { data } = await res.json();
    const {
      challenge,
      salt,
      expire_at,
      difficulty,
      signature,
      algorithm,
      target_path
    } = data.biz_data.challenge;

    const answer = await solvePow(challenge, salt, expire_at, difficulty);

    const encoded = Buffer.from(JSON.stringify({
      algorithm,
      challenge,
      salt,
      answer,
      signature,
      target_path
    })).toString('base64');

    return encoded;
  } catch (e) {
    return;
  }
}

export async function fetchHistoryMessages(TOKEN, sessionId) {
  try {
    const url = `https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${sessionId}&cache_version=-1`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { ...headers(TOKEN) },
      referrer: `https://chat.deepseek.com/a/chat/s/${sessionId}`,
      mode: 'cors',
      credentials: 'include'
    });
    if (!response.ok) return;
    return await response.json();
  } catch (e) {
    return;
  }
}

export async function* completion(TOKEN, prompt, CHAT_SESSION_ID, parentMessageId, stream = true, search = true, thinking = false, file_ids = []) {
  let pow;
  try {
    pow = await generatePowHeader(TOKEN, CHAT_SESSION_ID, '/api/v0/chat/completion');
  } catch (e) {
    pow = null;
  }

  let response;
  try {
    response = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
      method: 'POST',
      headers: {
        ...headers(TOKEN),
        'content-type': 'application/json',
        ...(pow ? { 'x-ds-pow-response': pow } : {}),
        referer: `https://chat.deepseek.com/a/chat/s/${CHAT_SESSION_ID}`
      },
      body: JSON.stringify({
        chat_session_id: CHAT_SESSION_ID,
        parent_message_id: parentMessageId,
        prompt,
        ref_file_ids: file_ids,
        thinking_enabled: thinking,
        search_enabled: search
      })
    });
  } catch (e) {
    if (!stream) return '';
    yield '❌ Network error while requesting completion';
    return;
  }

  if (!response || !response.ok) {
    if (!stream) return '';
    yield `❌ Server returned ${response ? response.status : 'no response'}`;
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const json = await response.json();
      const text = JSON.stringify(json);
      if (stream) yield text;
      else return text;
      return;
    } catch (e) {
      if (stream) yield '❌ Failed to parse JSON response';
      else return '';
      return;
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    if (!stream) return '';
    yield '❌ No readable stream on response';
    return;
  }

  const decoder = new TextDecoder('utf-8');
  let streamresponse = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });

    if (chunk.includes('challenge-platform')) {
      const msg = 'Detected by Cloudflare, please try again and increase the request delay';
      if (stream) yield msg;
      else streamresponse = msg;
      continue;
    }

    const lines = chunk.split('\n').filter(l => l.trim().startsWith('data:'));
    if (lines.length > 0) {
      for (const line of lines) {
        const payload = line.replace(/^data:\s*/, '').trim();
        if (!payload) continue;
        try {
          const json = JSON.parse(payload);
          if (typeof json?.v === 'string' && !['SEARCHING', 'FINISHED', 'ANSWER'].includes(json.v)) {
            if (stream) {
              yield json.v;
            } else {
              streamresponse += json.v;
            }
          }
        } catch (e) {
          if (stream) yield payload;
          else streamresponse += payload;
        }
      }
    } else {
      if (stream) yield chunk;
      else streamresponse += chunk;
    }
  }

  if (!stream) return streamresponse;
}
