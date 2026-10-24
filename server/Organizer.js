const express = require('express');
const next = require('next');
const path = require('node:path');
const { loadEnvConfig } = require('@next/env');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const dev = process.env.NODE_ENV !== 'production';
loadEnvConfig(REPOSITORY_ROOT, dev);
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
    const server = express();

    console.log('neabling planner');

    server.use('/', (req, res) => {
        res.redirect('/organizer')
    });

    
});