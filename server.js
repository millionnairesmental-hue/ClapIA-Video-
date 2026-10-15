import express from "express";
import path from "path";
import { fal } from "@fal-ai/client";

const app = express();
const port = process.env.PORT || 3000;
const model = process.env.VIDEO_MODEL || "fal-ai/veo3.1";

if (!process.env.FAL_KEY) {
  console.warn("FAL_KEY is not set. Add it to .env before generating.");
}

fal.config({ credentials: process.env.FAL_KEY });

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// Simple in-memory credits store (ephemeral). For production use a persistent store (Redis, DB).
const creditsStore = new Map();
const STARTING_CREDITS = Number(process.env.STARTING_CREDITS) || 20;
const COST_PER_VIDEO = Number(process.env.COST_PER_VIDEO) || 5;

function clientIdFromReq(req) {
  // Use X-Forwarded-For when behind a proxy, fallback to req.ip
  const xfwd = req.headers['x-forwarded-for'];
  if (xfwd) return xfwd.split(',')[0].trim();
  return req.ip || 'anonymous';
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.get('/api/credits', (req, res) => {
  const id = clientIdFromReq(req);
  if (!creditsStore.has(id)) creditsStore.set(id, STARTING_CREDITS);
  res.json({ credits: creditsStore.get(id) });
});

app.post("/api/generate", async (req, res) => {
  const id = clientIdFromReq(req);
  if (!creditsStore.has(id)) creditsStore.set(id, STARTING_CREDITS);

  try {
    const { prompt, aspect_ratio = "9:16", duration = "5" } = req.body || {};
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
      return res.status(400).json({ error: "Prompt trop court.", credits: creditsStore.get(id) });
    }

    const currentCredits = creditsStore.get(id) || 0;
    if (currentCredits < COST_PER_VIDEO) {
      return res.status(402).json({ error: "Crédits insuffisants.", credits: currentCredits });
    }

    // Déduire les crédits avant d'appeler le fournisseur pour éviter de surconsommer
    creditsStore.set(id, currentCredits - COST_PER_VIDEO);

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
      // Rembourser si l'appel échoue
      creditsStore.set(id, (creditsStore.get(id) || 0) + COST_PER_VIDEO);
      console.error('fal.subscribe error', callErr);
      return res.status(502).json({ error: "Erreur du fournisseur de vidéo.", credits: creditsStore.get(id) });
    }

    const videoUrl = result?.data?.video?.url;
    if (!videoUrl) {
      // Remboursement si pas de vidéo
      creditsStore.set(id, (creditsStore.get(id) || 0) + COST_PER_VIDEO);
      return res.status(502).json({ error: "Le fournisseur n'a pas retourné de vidéo.", credits: creditsStore.get(id) });
    }

    res.json({
      ok: true,
      videoUrl,
      model,
      status: "completed",
      credits: creditsStore.get(id)
    });
  } catch (error) {
    console.error(error);
    // tentative de remboursement en cas d'erreur inattendue
    try { creditsStore.set(id, (creditsStore.get(id) || 0) + COST_PER_VIDEO); } catch(e){}
    res.status(500).json({
      error: error?.message || "Erreur pendant la génération.",
      credits: creditsStore.get(id)
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "ClapIA Video", model });
});

app.listen(port, () => {
  console.log(`ClapIA Video running on port ${port}`);
});
