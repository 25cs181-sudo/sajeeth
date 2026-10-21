'use strict';
// DEMO server so the module can be run on its own. In the real project, call
// registerSignaling(io, { authenticate, isInProximity }) with your teammates' functions.
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { registerSignaling } = require('./signaling');
const demo = require('./signaling/demoAdapters');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server);
registerSignaling(io, { ...demo, sweepIntervalMs: 5000 });

const port = process.env.PORT || 3000;
if (require.main === module) server.listen(port, () => console.log(`ProxiSpeak signaling on :${port}`));
module.exports = { app, server, io };
