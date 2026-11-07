# Liste-cadeau — Mon catalogue de Noël

Application web (HTML/CSS/JS, PWA) pour gérer ses envies et les cadeaux de sa famille.

- Version actuelle (branche `main`) : données enregistrées dans le navigateur (`localStorage`, clé `noel2026`).
- Version collaborative (branche `v2-collaborative`) : en cours de développement (comptes Supabase, listes partagées).

## Sauvegarde

Accueil → « Ma sauvegarde » : exporter / restaurer un fichier JSON.

## Version 2 (comptes et listes partagées)
- `index.html` + `js/` + `style.css` + `v2.css` : application V2 (Supabase).
- `local.html` : l'ancienne version sans compte (données dans le navigateur), conservée telle quelle.
- `supabase/` : migrations SQL (droits RLS), fonction `fetch-og`. Voir `docs/SUPABASE-SETUP.md`.
- Tests : `cd tests && npm install && npm test`.
