# Godamo

Wholesale and distribution management platform for Nepal, by Cezvora
Technology.

See [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) for the full product
context, business rules, and Nepal-specific requirements.

## Folder Structure

```
godamo/
  apps/
    api-js/      API in plain JavaScript (Node.js + Express + Prisma + PostgreSQL);
                 also serves the web app
    web-html/    Office web app in plain HTML, CSS and JavaScript
    field_app/   Flutter field app for salesmen and drivers (Android first)
    api/         Previous NestJS API (TypeScript), kept for reference
    web/         Previous Next.js web app (React, TypeScript), kept for reference
  docs/
    PROJECT_CONTEXT.md
  .gitignore
  README.md
```

## Running

From the `godamo` folder (or the folder above it):

```
npm run dev
```

One server runs on **http://localhost:4000**:

- web app: http://localhost:4000/login
- API: http://localhost:4000/api/v1 (same routes and responses as before, so
  the Field app needs no change)

`npm test` runs the unit tests (Node's built-in test runner).

### First-time setup (`apps/api-js`)

```
cd apps/api-js
npm install            # also generates the Prisma client
cp .env.example .env   # then fill in DATABASE_URL and the JWT secrets
npm run migrate        # create / update the database tables
npm run seed           # optional demo data (company code DEMO)
```

The web app keeps the login in httpOnly cookies (`/web-auth/login`,
`/web-auth/refresh`, `/web-auth/logout`); page scripts never see a token.
The Field app keeps using `Authorization: Bearer` tokens from `/api/v1/auth/*`.

`npm run dev:old` still starts the previous NestJS API (4000) and Next.js web
app (4001).

### Field App (`apps/field_app`)

```
cd apps/field_app
flutter run
```
