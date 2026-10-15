# ClapIA Video

MVP mobile-first pour générer une vidéo IA depuis un prompt.

## Architecture
- `public/` : interface mobile (index.html déplacé ici)
- `server.js` : serveur Express + appel fal.ai
- Authentification minimale : register/login via email+password (JWT)
- Crédits stockés en Redis (recommandé) ou mémoire (fallback éphémère)

## Endpoints
- `POST /api/register` {email,password} -> { token, credits }
- `POST /api/login` {email,password} -> { token, credits }
- `GET /api/credits` -> { credits } (auth optional)
- `POST /api/generate` { prompt, aspect_ratio, duration } -> { videoUrl, credits }

## Lancer
1. Installer Node.js 20+
2. Copier `.env.example` vers `.env`
3. Mettre ta clé fal.ai dans `FAL_KEY` et (optionnel) `REDIS_URL`, `JWT_SECRET`
4. `npm install`
5. `npm start`
6. Ouvrir `http://localhost:3000`

## Docker
Un Dockerfile est fourni. Pour construire : `docker build -t clapia-video .` puis `docker run -p 3000:3000 --env-file .env clapia-video`

## Important
- Pour production : utilisez une instance Redis, un secret JWT sécurisé et HTTPS.
- Les coûts de génération sont facturés par le fournisseur. Vérifie les tarifs actuels avant de vendre des crédits.
