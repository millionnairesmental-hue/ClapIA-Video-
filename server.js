import express from "express";
import path from "path";
import dotenv from "dotenv";
import { fal } from "@fal-ai/client";
import Redis from "ioredis";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const model = process.env.VIDEO_MODEL || "fal-ai/veo3.1";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

if (!process.env.FAL_KEY) {
  console.warn("FAL_KEY is not set. Add it to .env before generating.");
}
if (!process.env.JWT_SECRET) {
  console.warn("JWT_SECRET is not set. Using a default development secret. Set JWT_SECRET in production.");
}

fal.config({ credentials: process.env.FAL_KEY });

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// Redis if available (recommended). Fallback to in-memory Maps for demo/dev.
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  redis.on('error', (e) => console.error('Redis error', e));
} else {
  console.warn('REDIS_URL not set — using in-memory store (ephemeral).');
}

const inMemoryUsers = new Map(); // email -> { email, passwordHash }
const inMemoryCredits = new Map(); // key -> number

const STARTING_CREDITS = Number(process.env.STARTING_CREDITS) || 20;
const COST_PER_VIDEO = Number(process.env.COST_PER_VIDEO) || 5;

function anonKeyFromReq(req) {
  const xfwd = req.headers['x-forwarded-for'];
  if (xfwd) return `anon:${xfwd.split(',')[0].trim()}`;
  return `anon:${req.ip || 'unknown'}`;
}

async function getUser(email) {
  if (!email) return null;
  if (redis) {
    const raw = await redis.get(`user:${email}`);
    return raw ? JSON.parse(raw) : null;
  }
  return inMemoryUsers.get(email) || null;
}

async function setUser(email, user) {
  if (redis) {
    await redis.set(`user:${email}`, JSON.stringify(user));
    return;
  }
  inMemoryUsers.set(email, user);
}

async function getCreditsKey(key) {
  if (redis) {
    const v = await redis.get(`credits:${key}`);
    return v ? Number(v) : 0;
  }
  return inMemoryCredits.get(key) || 0;
}

async function setCreditsKey(key, value) {
  if (redis) {
    await redis.set(`credits:${key}`, String(value));
    return;
  }
  inMemoryCredits.set(key, value);
}

async function incrCredits(key, amount) {
  if (redis) {
    return await redis.incrby(`credits:${key}`, amount);
  }
  const cur = inMemoryCredits.get(key) || 0;
  const next = cur + amount;
  inMemoryCredits.set(key, next);
  return next;
}

async function decrCredits(key, amount) {
  if (redis) {
    return await redis.decrby(`credits:${key}`, amount);
  }
  const cur = inMemoryCredits.get(key) || 0;
  const next = Math.max(0, cur - amount);
  inMemoryCredits.set(key, next);
  return next;
}

// Auth helpers
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

async function ensureUserCredits(email) {
  const key = `user:${email}`;
  const credits = await getCreditsKey(key);
  if (!credits) {
    await setCreditsKey(key, STARTING_CREDITS);
    return STARTING_CREDITS;
  }
  return credits;
}

// Public root - serve index
app.get('/', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// Register
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email et mot de passe requis (6+ caractères).' });
  }
  const existing = await getUser(email);
  if (existing) return res.status(409).json({ error: 'Utilisateur déjà existant.' });
  const passwordHash = await bcrypt.hash(password, 10);
  await setUser(email, { email, passwordHash });
  // set starting credits
  await setCreditsKey(`user:${email}`, STARTING_CREDITS);
  const token = signToken({ email });
  res.json({ ok: true, token, credits: STARTING_CREDITS });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });
  const user = await getUser(email);
  if (!user) return res.status(401).json({ error: 'Utilisateur non trouvé.' });
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Mot de passe incorrect.' });
  const token = signToken({ email });
  const credits = await ensureUserCredits(email);
  res.json({ ok: true, token, credits });
});

// Optional auth middleware
async function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return next();
  const parts = auth.split(' ');
  if (parts.length !== 2) return next();
  const token = parts[1];
  const payload = verifyToken(token);
  if (!payload) return next();
  req.user = payload;
  return next();
}

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Authorization required.' });
  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'Bad authorization header.' });
  const token = parts[1];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token.' });
  req.user = payload;
  next();
}

// Get credits (authenticated or anonymous)
app.get('/api/credits', optionalAuth, async (req, res) => {
  try {
    if (req.user && req.user.email) {
      const key = `user:${req.user.email}`;
      const credits = await ensureUserCredits(req.user.email);
      return res.json({ credits });
    }
    // anonymous
    const key = anonKeyFromReq(req);
    if (! (await getCreditsKey(key))) {
      await setCreditsKey(key, STARTING_CREDITS);
    }
    const credits = await getCreditsKey(key);
    return res.json({ credits });
  } catch (e) {
    console.error(e);
    return res.json({ credits: 0 });
  }
});

// Generate endpoint: requires auth (for now prefer authenticated users). Anonymous allowed but uses IP-based credits.
app.post('/api/generate', optionalAuth, async (req, res) => {
  try {
    const { prompt, aspect_ratio = '9:16', duration = '5' } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
      return res.status(400).json({ error: 'Prompt trop court.' });
    }

    // Determine billing key
    let billingKey;
    if (req.user && req.user.email) {
      billingKey = `user:${req.user.email}`;
      await ensureUserCredits(req.user.email);
    } else {
      billingKey = anonKeyFromReq(req);
      if (! (await getCreditsKey(billingKey))) {
        await setCreditsKey(billingKey, STARTING_CREDITS);
      }
    }

    const currentCredits = await getCreditsKey(billingKey);
    if (currentCredits < COST_PER_VIDEO) {
      return res.status(402).json({ error: 'Crédits insuffisants.', credits: currentCredits });
    }

    // Debit now, refund on error
    await decrCredits(billingKey, COST_PER_VIDEO);

    const safePrompt = prompt.trim().slice(0, 4000);
    let result;
    try {
      result = await fal.subscribe(model, {
        input: {
          prompt: safePrompt,
          aspect_ratio,
          duration: Number(duration)
        },
        logs: false
      });
    } catch (callErr) {
      console.error('fal.subscribe error', callErr);
      await incrCredits(billingKey, COST_PER_VIDEO);
      return res.status(502).json({ error: 'Erreur du fournisseur de vidéo.', credits: await getCreditsKey(billingKey) });
    }

    const videoUrl = result?.data?.video?.url;
    if (!videoUrl) {
      await incrCredits(billingKey, COST_PER_VIDEO);
      return res.status(502).json({ error: "Le fournisseur n'a pas retourné de vidéo.", credits: await getCreditsKey(billingKey) });
    }

    res.json({ ok: true, videoUrl, model, status: 'completed', credits: await getCreditsKey(billingKey) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error?.message || 'Erreur pendant la génération.' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'ClapIA Video', model });
});

app.listen(port, () => {
  console.log(`ClapIA Video running on port ${port}`);
});
