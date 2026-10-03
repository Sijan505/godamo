// Vercel serverless entry point: every request that isn't a static file
// (see vercel.json) is handled by the Godamo Express app.
import { createApp } from '../apps/api-js/src/app.js';

export default createApp();
