# Configuration de Supabase (une seule fois)

## 1. Créer la base (SQL)
Supabase → **SQL Editor** → **New query**. Colle puis exécute (**Run**), dans cet ordre :
1. `supabase/migrations/20261105000001_init.sql`
2. `supabase/migrations/20261105000002_import_legacy.sql`

Chaque fichier doit se terminer par « Success ». Ne les exécute qu'une fois.

## 2. Authentification
Supabase → **Authentication → URL Configuration** :
- **Site URL** : `https://asch13320-cloud.github.io/Liste-cadeau/`
- **Redirect URLs** : ajoute la même adresse.

Supabase → **Authentication → Providers → Email** : laisse « Confirm email » activé et fixe un mot de passe d'au moins 8 caractères.
Remarque : l'envoi d'e-mails par défaut de Supabase est limité (quelques e-mails par heure). Suffisant pour une famille ; un SMTP personnalisé est possible plus tard.

## 3. Fonction de prévisualisation des liens
Supabase → **Edge Functions → Deploy a new function** (ou CLI : `supabase functions deploy fetch-og`) :
- nom : `fetch-og`, fichiers : `supabase/functions/fetch-og/index.ts` et `og.js`.
- Garder **Verify JWT** activé.
- Secret facultatif : `ALLOWED_ORIGINS` (par défaut `https://asch13320-cloud.github.io`).

## 4. Clés à mettre dans l'application
Supabase → **Project Settings → API Keys** : copie l'**URL du projet** et la clé **publishable** (publique).
**Ne jamais** mettre la clé `secret` / `service_role` dans l'application ni dans GitHub.

## 5. Photos
Le bucket privé `gift-photos` (3 Mo, JPEG/PNG/WebP) est créé par la migration. Rien à faire.

## Limites connues
- Supprimer un cadeau ne supprime pas encore sa photo du stockage (nettoyage à prévoir côté application).
- Les évènements temps réel de suppression ne transportent que l'identifiant : l'application recharge la liste à chaque évènement.
- Sites qui bloquent la lecture automatique : l'application propose la saisie manuelle du titre et de la photo.
