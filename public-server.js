#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');

// Configuration
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = path.join(__dirname, 'server.json');

// Seed admin token from env or fall back to provided token
const DEFAULT_ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin_7f9e2a1b_8c4d_9e5f_0a1b_2c3d4e5f6a7b';

/**
 * Load or initialize the data file that stores admin token and allow/block lists
 */
function loadData(){
	try {
		if (!fs.existsSync(DATA_FILE)) {
			const seed = { adminToken: DEFAULT_ADMIN_TOKEN, allow: [], block: [] };
			fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
			return seed;
		}
		const raw = fs.readFileSync(DATA_FILE, 'utf-8');
		const parsed = JSON.parse(raw || '{}');
		if (!parsed.adminToken) parsed.adminToken = DEFAULT_ADMIN_TOKEN;
		if (!Array.isArray(parsed.allow)) parsed.allow = [];
		if (!Array.isArray(parsed.block)) parsed.block = [];
		return parsed;
	} catch (e) {
		return { adminToken: DEFAULT_ADMIN_TOKEN, allow: [], block: [] };
	}
}

function saveData(data){
	try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch {}
}

let state = loadData();

function isAuthorized(req){
	const h = req.headers['authorization'] || '';
	const token = h.startsWith('Bearer ') ? h.slice(7) : '';
	return token && token === state.adminToken;
}

function sendJson(res, code, body){
	const json = JSON.stringify(body);
	res.writeHead(code, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(json),
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
	});
	res.end(json);
}

function notFound(res){ sendJson(res, 404, { error: 'Not found' }); }
function unauthorized(res){ sendJson(res, 401, { error: 'Unauthorized' }); }

function readBody(req){
	return new Promise(resolve => {
		let data = '';
		req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
		req.on('end', () => {
			try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
		});
	});
}

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const pathname = url.pathname || '/';
		const searchParams = url.searchParams;
		
		if (req.method === 'OPTIONS') return sendJson(res, 200, {});

		// Health
		if (pathname === '/health') return sendJson(res, 200, { ok: true });

		// License check endpoint: GET /check?deviceId=<sha256hex>
		if (pathname === '/check' && req.method === 'GET') {
			const deviceId = String(searchParams.get('deviceId') || '').trim();
			let allowed = false;
			let reason = '';
			if (!deviceId) { allowed = false; reason = 'missing deviceId'; }
			else if (state.block.includes(deviceId)) { allowed = false; reason = 'blocked'; }
			else if (state.allow.includes(deviceId)) { allowed = true; }
			else { allowed = false; reason = 'not allowed'; }
			return sendJson(res, 200, { allowed, forceExit: !allowed, intervalSec: 30, reason });
		}

		// Below endpoints require admin token
		if (!isAuthorized(req)) return unauthorized(res);

		// GET /list
		if (pathname === '/list' && req.method === 'GET') {
			return sendJson(res, 200, { allow: state.allow, block: state.block });
		}

		// POST /allow { deviceId }
		if (pathname === '/allow' && req.method === 'POST') {
			const body = await readBody(req);
			const deviceId = String(body.deviceId || '').trim();
			if (!deviceId) return sendJson(res, 400, { error: 'deviceId required' });
			if (!state.allow.includes(deviceId)) state.allow.push(deviceId);
			state.block = state.block.filter(x => x !== deviceId);
			saveData(state);
			return sendJson(res, 200, { ok: true, allow: state.allow });
		}

		// POST /block { deviceId }
		if (pathname === '/block' && req.method === 'POST') {
			const body = await readBody(req);
			const deviceId = String(body.deviceId || '').trim();
			if (!deviceId) return sendJson(res, 400, { error: 'deviceId required' });
			if (!state.block.includes(deviceId)) state.block.push(deviceId);
			state.allow = state.allow.filter(x => x !== deviceId);
			saveData(state);
			return sendJson(res, 200, { ok: true, block: state.block });
		}

		// DELETE /allow?deviceId=...
		if (pathname === '/allow' && req.method === 'DELETE') {
			const deviceId = String(searchParams.get('deviceId') || '').trim();
			state.allow = state.allow.filter(x => x !== deviceId);
			saveData(state);
			return sendJson(res, 200, { ok: true, allow: state.allow });
		}

		// DELETE /block?deviceId=...
		if (pathname === '/block' && req.method === 'DELETE') {
			const deviceId = String(searchParams.get('deviceId') || '').trim();
			state.block = state.block.filter(x => x !== deviceId);
			saveData(state);
			return sendJson(res, 200, { ok: true, block: state.block });
		}

		notFound(res);
	} catch (error) {
		console.error('Server error:', error);
		sendJson(res, 500, { error: 'Internal server error' });
	}
});

server.listen(PORT, HOST, () => {
	console.log(`🌐 Public License Server listening on http://${HOST}:${PORT}`);
	console.log(`🔑 Admin token: ${state.adminToken}`);
	console.log(`📊 Server Status: ONLINE`);
	console.log(`🌍 Accessible from: http://YOUR_PUBLIC_IP:${PORT}`);
});

// Handle server errors
server.on('error', (error) => {
	console.error('Server error:', error);
	if (error.code === 'EADDRINUSE') {
		console.error(`Port ${PORT} is already in use. Please try a different port.`);
	}
});

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('\n🛑 Shutting down server...');
	server.close(() => {
		console.log('✅ Server closed');
		process.exit(0);
	});
});
