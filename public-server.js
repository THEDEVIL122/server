#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');

// Configuration
const PORT = Number(process.env.PORT || 8080);
const DEFAULT_ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin_7f9e2a1b_8c4d_9e5f_0a1b_2c3d4e5f6a7b';
const SERVER_FILE = 'server.json';

// Seed admin token from env or fall back to provided token

/**
 * Load or initialize the data file that stores admin token and allow/block lists
 */
function loadServerData() {
	try {
		if (fs.existsSync(SERVER_FILE)) {
			const data = fs.readFileSync(SERVER_FILE, 'utf8');
			const parsed = JSON.parse(data);
			return {
				adminToken: parsed.adminToken || DEFAULT_ADMIN_TOKEN,
				allow: parsed.allow || [],
				block: parsed.block || [],
				pending: parsed.pending || [], // New: pending requests
				lastSeen: parsed.lastSeen || {} // New: track when devices were last seen
			};
		}
	} catch (error) {
		console.error('Error loading server data:', error);
	}
	
	const seed = { 
		adminToken: DEFAULT_ADMIN_TOKEN, 
		allow: [], 
		block: [],
		pending: [],
		lastSeen: {}
	};
	
	try {
		fs.writeFileSync(SERVER_FILE, JSON.stringify(seed, null, 2));
	} catch (error) {
		console.error('Error creating server file:', error);
	}
	
	return seed;
}

function saveServerData(data) {
	try {
		fs.writeFileSync(SERVER_FILE, JSON.stringify(data, null, 2));
	} catch (error) {
		console.error('Error saving server data:', error);
	}
}

function sendJson(res, statusCode, data) {
	res.writeHead(statusCode, {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization'
	});
	res.end(JSON.stringify(data));
}

function authenticateRequest(req) {
	const authHeader = req.headers.authorization;
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return false;
	}
	
	const token = authHeader.substring(7);
	const serverData = loadServerData();
	return token === serverData.adminToken;
}

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const pathname = url.pathname || '/';
		const searchParams = url.searchParams;
		
		if (req.method === 'OPTIONS') return sendJson(res, 200, {});
		
		console.log(`${new Date().toISOString()} - ${req.method} ${pathname}`);
		
		// Health check
		if (pathname === '/health') {
			return sendJson(res, 200, { ok: true, timestamp: new Date().toISOString() });
		}
		
		// License check with pending tracking
		if (pathname === '/check') {
			const deviceId = String(searchParams.get('deviceId') || '').trim();
			const version = String(searchParams.get('v') || '').trim();
			
			if (!deviceId) {
				return sendJson(res, 400, { 
					allowed: false, 
					forceExit: true, 
					intervalSec: 30, 
					reason: 'missing deviceId' 
				});
			}
			
			const serverData = loadServerData();
			const now = new Date().toISOString();
			
			// Update last seen
			serverData.lastSeen[deviceId] = now;
			
			// Check if device is in allow list
			if (serverData.allow.includes(deviceId)) {
				saveServerData(serverData);
				return sendJson(res, 200, { 
					allowed: true, 
					forceExit: false, 
					intervalSec: 30, 
					reason: '' 
				});
			}
			
			// Check if device is in block list
			if (serverData.block.includes(deviceId)) {
				saveServerData(serverData);
				return sendJson(res, 200, { 
					allowed: false, 
					forceExit: true, 
					intervalSec: 30, 
					reason: 'device blocked' 
				});
			}
			
			// Device is not in allow or block - add to pending if not already there
			if (!serverData.pending.includes(deviceId)) {
				serverData.pending.push(deviceId);
				console.log(`🔔 New pending device: ${deviceId} (v${version})`);
			}
			
			saveServerData(serverData);
			
			return sendJson(res, 200, { 
				allowed: false, 
				forceExit: true, 
				intervalSec: 30, 
				reason: 'not allowed' 
			});
		}
		
		// Admin endpoints
		if (!authenticateRequest(req)) {
			return sendJson(res, 401, { error: 'Unauthorized' });
		}
		
		// Get all data (including pending)
		if (pathname === '/list') {
			const serverData = loadServerData();
			return sendJson(res, 200, {
				allow: serverData.allow,
				block: serverData.block,
				pending: serverData.pending,
				lastSeen: serverData.lastSeen
			});
		}
		
		// Allow device
		if (pathname === '/allow' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => body += chunk);
			req.on('end', () => {
				try {
					const { deviceId } = JSON.parse(body);
					if (!deviceId) {
						return sendJson(res, 400, { error: 'deviceId required' });
					}
					
					const serverData = loadServerData();
					
					// Remove from pending and block lists
					serverData.pending = serverData.pending.filter(id => id !== deviceId);
					serverData.block = serverData.block.filter(id => id !== deviceId);
					
					// Add to allow list if not already there
					if (!serverData.allow.includes(deviceId)) {
						serverData.allow.push(deviceId);
					}
					
					saveServerData(serverData);
					console.log(`✅ Device allowed: ${deviceId}`);
					
					return sendJson(res, 200, { 
						ok: true, 
						allow: serverData.allow 
					});
				} catch (error) {
					return sendJson(res, 400, { error: 'Invalid JSON' });
				}
			});
			return;
		}
		
		// Block device
		if (pathname === '/block' && req.method === 'POST') {
			let body = '';
			req.on('data', chunk => body += chunk);
			req.on('end', () => {
				try {
					const { deviceId } = JSON.parse(body);
					if (!deviceId) {
						return sendJson(res, 400, { error: 'deviceId required' });
					}
					
					const serverData = loadServerData();
					
					// Remove from pending and allow lists
					serverData.pending = serverData.pending.filter(id => id !== deviceId);
					serverData.allow = serverData.allow.filter(id => id !== deviceId);
					
					// Add to block list if not already there
					if (!serverData.block.includes(deviceId)) {
						serverData.block.push(deviceId);
					}
					
					saveServerData(serverData);
					console.log(`❌ Device blocked: ${deviceId}`);
					
					return sendJson(res, 200, { 
						ok: true, 
						block: serverData.block 
					});
				} catch (error) {
					return sendJson(res, 400, { error: 'Invalid JSON' });
				}
			});
			return;
		}
		
		// Remove from allow list
		if (pathname === '/allow' && req.method === 'DELETE') {
			const deviceId = searchParams.get('deviceId');
			if (!deviceId) {
				return sendJson(res, 400, { error: 'deviceId required' });
			}
			
			const serverData = loadServerData();
			serverData.allow = serverData.allow.filter(id => id !== deviceId);
			saveServerData(serverData);
			
			return sendJson(res, 200, { 
				ok: true, 
				allow: serverData.allow 
			});
		}
		
		// Remove from block list
		if (pathname === '/block' && req.method === 'DELETE') {
			const deviceId = searchParams.get('deviceId');
			if (!deviceId) {
				return sendJson(res, 400, { error: 'deviceId required' });
			}
			
			const serverData = loadServerData();
			serverData.block = serverData.block.filter(id => id !== deviceId);
			saveServerData(serverData);
			
			return sendJson(res, 200, { 
				ok: true, 
				block: serverData.block 
			});
		}
		
		// Clear pending requests
		if (pathname === '/pending' && req.method === 'DELETE') {
			const serverData = loadServerData();
			serverData.pending = [];
			saveServerData(serverData);
			
			return sendJson(res, 200, { 
				ok: true, 
				pending: [] 
			});
		}
		
		// Default response
		return sendJson(res, 404, { error: 'Not found' });
		
	} catch (error) {
		console.error('Server error:', error);
		sendJson(res, 500, { error: 'Internal server error' });
	}
});

server.on('error', (error) => {
	console.error('Server error:', error);
	if (error.code === 'EADDRINUSE') {
		console.error(`Port ${PORT} is already in use. Please try a different port.`);
	}
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`🌐 Public License Server listening on http://0.0.0.0:${PORT}`);
	console.log(`🔑 Admin token: ${DEFAULT_ADMIN_TOKEN}`);
	console.log(`📊 Server Status: ONLINE`);
	console.log(`🌍 Accessible from: https://server-production-3af3.up.railway.app`);
});

// Graceful shutdown
process.on('SIGINT', () => {
	console.log('\n🛑 Shutting down server...');
	server.close(() => {
		console.log('✅ Server closed');
		process.exit(0);
	});
});

