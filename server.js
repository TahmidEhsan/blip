// Blip's entry point on Vercel. Vercel recognises an Express app by a root file like this one that
// imports express, and serves its default export as one function. Static files (public/**, with the
// vendor files `npm run build` copies into public/vendor) come from Vercel's CDN instead.
// This file never listens: local runs use `npm start` or `npm run dev` (server/index.js).
import 'express'; // what Vercel's framework detection looks for; the app is built in server/app.js
import { createVercelApp } from './server/vercel.js';

export default createVercelApp(process.env).app;
