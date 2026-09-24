# Godamo

Wholesale and distribution management platform for Nepal, by Cezvora
Technology.

See [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) for the full product
context, business rules, and Nepal-specific requirements.

## Folder Structure

```
godamo/
  apps/
    api/         NestJS backend API (Prisma ORM + PostgreSQL)
    web/         Next.js office web app (React, TypeScript, Tailwind CSS)
    field_app/   Flutter field app for salesmen and drivers (Android first)
  docs/
    PROJECT_CONTEXT.md
  .gitignore
  README.md
```

## Running Each App

### API (`apps/api`)

```
cd apps/api
npm run start:dev
```

Runs on **http://localhost:4000**.

### Web (`apps/web`)

```
cd apps/web
npm run dev
```

Runs on **http://localhost:4001**.

### Field App (`apps/field_app`)

```
cd apps/field_app
flutter run
```
