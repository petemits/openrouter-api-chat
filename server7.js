require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const puppeteer = require('puppeteer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

let availableModels = [];
let defaultModel = '';
let browserInstance = null;

// Initialize Puppeteer browser
async function initBrowser() {
    try {
        console.log('🔄 Initializing Puppeteer browser...');
        browserInstance = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        });
        console.log('✅ Puppeteer browser initialized');
    } catch (error) {
        console.error('❌ Failed to initialize browser:', error.message);
        browserInstance = null;
    }
}

// Fetch available models from OpenRouter
async function fetchModels() {
    try {
        console.log('Fetching available models from OpenRouter...');
        const response = await axios.get(OPENROUTER_BASE_URL + '/models', {
            headers: {
                'Authorization': 'Bearer ' + OPENROUTER_API_KEY
            },
            timeout: 10000
        });

        if (response.data && response.data.data) {
            const freeModels = response.data.data.filter(model => 
                model.id.includes(':free') || 
                (model.pricing && model.pricing.prompt === '0' && model.pricing.completion === '0')
            );

            availableModels = freeModels.map(model => ({
                id: model.id,
                name: model.name || model.id,
                description: model.description || 'AI Model'
            })).slice(0, 10);

            if (availableModels.length > 0) {
                defaultModel = availableModels[0].id;
                console.log('Found', availableModels.length, 'free models');
                console.log('Default model set to:', defaultModel);
            } else {
                availableModels = [
                    { id: 'google/gemini-2.0-flash-exp:free', name: 'Google Gemini 2.0 Flash' },
                    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B' }
                ];
                defaultModel = availableModels[0].id;
                console.log('Using fallback models');
            }
        }
    } catch (error) {
        console.error('Failed to fetch models, using fallback:', error.message);
        availableModels = [
            { id: 'google/gemini-2.0-flash-exp:free', name: 'Google Gemini 2.0 Flash' },
            { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B' }
        ];
        defaultModel = availableModels[0].id;
    }
}

const conversations = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==================== ROOT ROUTE - THIS WAS MISSING ====================
app.get('/', (req, res) => {
    let modelsOptions = '';
    availableModels.forEach(model => {
        const selected = model.id === defaultModel ? ' selected' : '';
        modelsOptions += '<option value="' + model.id + '"' + selected + '>' + model.name + '</option>';
    });

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>AI Business Analysis App</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .container {
            width: 95%; max-width: 1200px; height: 95vh;
            background: white; border-radius: 15px;
            display: flex; flex-direction: column;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        header {
            background: #2c3e50; color: white; padding: 20px;
            text-align: center; border-radius: 15px 15px 0 0;
        }
        .tabs {
            display: flex; background: #34495e; padding: 0;
        }
        .tab {
            padding: 15px 20px; color: white; cursor: pointer;
            border: none; background: none; flex: 1;
            transition: background 0.3s;
        }
        .tab.active {
            background: #1abc9c;
        }
        .tab-content {
            display: none; flex: 1; padding: 20px;
            overflow-y: auto; background: #f8f9fa;
        }
        .tab-content.active {
            display: flex; flex-direction: column;
        }
        .controls {
            background: white; padding: 20px; border-radius: 10px;
            margin-bottom: 15px; border: 1px solid #e1e8ed;
        }
        input, select, textarea, button {
            padding: 12px; margin: 8px; border: 1px solid #ddd;
            border-radius: 8px; font-size: 14px;
        }
        button {
            background: #3498db; color: white; cursor: pointer;
            border: none; transition: background 0.3s;
            font-weight: 600;
        }
        button:hover { background: #2980b9; }
        button:disabled { background: #7f8c8d; cursor: not-allowed; }
        .chat-area, .analysis-area, .search-area, .maps-area {
            flex: 1; background: white; border: 1px solid #e1e8ed;
            border-radius: 10px; padding: 20px; overflow-y: auto;
            margin-bottom: 15px;
        }
        .message {
            margin: 12px 0; padding: 15px; border-radius: 12px;
            max-width: 90%; line-height: 1.5;
        }
        .user-message {
            background: #007bff; color: white; margin-left: auto;
        }
        .ai-message {
            background: #f8f9fa; border: 1px solid #e1e8ed;
        }
        .report-content {
            white-space: pre-wrap; line-height: 1.6;
            background: white; padding: 15px; border-radius: 8px;
            border: 1px solid #e1e8ed; margin: 10px 0;
        }
        .typing, .loading {
            color: #666; font-style: italic; padding: 15px;
            display: none; text-align: center;
            background: #f8f9fa; border-radius: 8px;
            margin: 10px 0;
        }
        .model-badge {
            background: #3498db; color: white; padding: 4px 12px;
            border-radius: 12px; font-size: 0.8em; margin-left: 8px;
        }
        .error-message {
            background: #ffebee; color: #c62828; border: 1px solid #f44336;
        }
        .success-message {
            background: #e8f5e8; color: #2e7d32; border: 1px solid #4caf50;
        }
        .info-message {
            background: #e3f2fd; color: #1565c0; border: 1px solid #2196f3;
        }
        .contact-info {
            background: #e3f2fd; border: 1px solid #bbdefb; 
            padding: 12px; border-radius: 8px; margin: 8px 0;
        }
        .search-result {
            background: #f8f9fa; border: 1px solid #e1e8ed;
            padding: 15px; margin: 10px 0; border-radius: 8px;
        }
        .location-result {
            background: #f0f8ff; border: 1px solid #b3d9ff;
            padding: 15px; margin: 10px 0; border-radius: 8px;
        }
        .data-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 10px; margin: 10px 0;
        }
        .data-item {
            background: #f8f9fa; padding: 10px; border-radius: 5px;
            border: 1px solid #e1e8ed;
        }
        .map-container {
            height: 400px; width: 100%; border-radius: 8px;
            border: 1px solid #ddd; margin: 10px 0;
        }
        .location-suggestion {
            background: #e8f5e9; border: 1px solid #c8e6c9;
            padding: 10px; margin: 5px 0; border-radius: 5px;
            cursor: pointer;
        }
        .location-suggestion:hover {
            background: #c8e6c9;
        }
        .extraction-badge {
            background: #ff9800; color: white; padding: 4px 8px;
            border-radius: 10px; font-size: 0.7em; margin-left: 5px;
        }
        .screenshot {
            max-width: 100%; border: 1px solid #ddd; border-radius: 5px;
            margin: 10px 0;
        }
    </style>
    <!-- Leaflet CSS -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
</head>
<body>
    <div class="container">
        <header>
            <h1>🤖 AI Business Analysis App</h1>
            <p>AI Chat + Business Analysis + Web Search + Location Intelligence 🗺️</p>
        </header>
        
        <div class="tabs">
            <button class="tab active" onclick="switchTab('chat')">💬 AI Chat</button>
            <button class="tab" onclick="switchTab('analysis')">📊 Business Analysis</button>
            <button class="tab" onclick="switchTab('search')">🔍 Web Search</button>
            <button class="tab" onclick="switchTab('maps')">🗺️ Location Intelligence</button>
        </div>

        <!-- Chat Tab -->
        <div id="chat-tab" class="tab-content active">
            <div class="controls">
                <select id="modelSelect">` + modelsOptions + `</select>
                <button onclick="clearChat()">Clear Chat</button>
            </div>
            <div class="chat-area" id="chatArea">
                <div class="message ai-message">
                    <strong>🚀 Welcome to AI Business Analysis App!</strong><br><br>
                    <strong>✅ ENHANCED WITH PUPPETEER!</strong><br>
                    • <strong>AI Chat</strong> - Dynamic models from OpenRouter<br>
                    • <strong>Business Analysis</strong> - AI + Puppeteer extraction<br>
                    • <strong>Web Search</strong> - Multiple providers (Google CSE, SerpAPI, AI)<br>
                    • <strong>Location Intelligence</strong> - OpenStreetMap + AI Location Analysis<br>
                    • <strong>Puppeteer</strong> - Real website data extraction<br><br>
                    <strong>🔑 OpenRouter API: Active | Models: ` + availableModels.length + `</strong>
                </div>
            </div>
            <div class="typing" id="typingIndicator">AI is analyzing...</div>
            <div style="display: flex; gap: 10px;">
                <input type="text" id="messageInput" placeholder="Ask anything..." style="flex: 1;" onkeypress="handleKeyPress(event)">
                <button onclick="sendMessage()">Send</button>
            </div>
        </div>

        <!-- Business Analysis Tab -->
        <div id="analysis-tab" class="tab-content">
            <div class="controls">
                <div style="display: flex; gap: 10px; align-items: center;">
                    <input type="text" id="websiteUrl" placeholder="Enter website (e.g., apple.com)" style="flex: 1;" value="purilegalservices.ca">
                    <select id="analysisModel">` + modelsOptions + `</select>
                </div>
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button onclick="analyzeWebsite()">🔍 AI Website Analysis</button>
                    <button onclick="quickAnalysis()">⚡ Quick Analysis</button>
                    <button onclick="generateBusinessReport()">📈 Business Report</button>
                    <button onclick="enhancedAnalysis()">🔄 Enhanced Analysis</button>
                </div>
                <div style="margin-top: 10px; padding: 10px; background: #e3f2fd; border-radius: 5px; font-size: 0.9em;">
                    <strong>💡 ENHANCED ANALYSIS:</strong> AI + Puppeteer extraction for real data + AI intelligence
                </div>
            </div>
            <div class="analysis-area" id="analysisArea">
                <div class="message ai-message">
                    <strong>📊 ENHANCED Business Analysis</strong><br><br>
                    <strong>🔄 NEW: Puppeteer + AI Analysis</strong> - Real data extraction + AI intelligence<br>
                    <strong>✅ Enhanced Data:</strong> Real phone numbers, emails, addresses<br>
                    <strong>🤖 AI Intelligence:</strong> Business insights and patterns<br>
                    <strong>📸 Screenshots:</strong> Visual verification of websites<br><br>
                    Try: apple.com, google.com, amazon.com, purilegalservices.ca
                </div>
            </div>
            <div class="loading" id="analysisLoading">AI is analyzing business patterns...</div>
        </div>

        <!-- Web Search Tab -->
        <div id="search-tab" class="tab-content">
            <div class="controls">
                <div style="display: flex; gap: 10px; align-items: center;">
                    <input type="text" id="searchQuery" placeholder="Enter search query (e.g., best coffee shops in Toronto)" style="flex: 1;">
                    <select id="searchModel">` + modelsOptions + `</select>
                </div>
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button onclick="performSearch()">🔍 Search Web</button>
                    <button onclick="searchAndAnalyze()">🤖 Search & Analyze</button>
                    <button onclick="enhancedSearchAnalyze()">🔄 Enhanced Search</button>
                </div>
                <div style="margin-top: 10px; padding: 10px; background: #e3f2fd; border-radius: 5px; font-size: 0.9em;">
                    <strong>🔍 ENHANCED SEARCH:</strong> Uses Puppeteer + AI for comprehensive analysis
                </div>
            </div>
            <div class="search-area" id="searchArea">
                <div class="message ai-message">
                    <strong>ENHANCED Web Search & Analysis</strong><br><br>
                    Search the web and automatically analyze business websites using Puppeteer + AI intelligence.
                </div>
            </div>
            <div class="loading" id="searchLoading">Searching... Please wait</div>
        </div>

        <!-- Maps Tab -->
        <div id="maps-tab" class="tab-content">
            <div class="controls">
                <div style="display: flex; gap: 10px; align-items: center;">
                    <input type="text" id="locationQuery" placeholder="Enter location, business, or website URL" style="flex: 1;" value="purilegalservices.ca">
                    <select id="mapService">
                        <option value="openstreetmap">OpenStreetMap</option>
                        <option value="ai">AI Location Analysis</option>
                    </select>
                </div>
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button onclick="searchLocation()">🗺️ Search Location</button>
                    <button onclick="showMapDemo()">🌍 Show Map Demo</button>
                    <button onclick="analyzeWebsiteLocation()">🏢 Website Location</button>
                </div>
                <div style="margin-top: 10px; padding: 10px; background: #e3f2fd; border-radius: 5px; font-size: 0.9em;">
                    <strong>🗺️ Location Intelligence:</strong> Works with addresses, business names, AND website URLs!
                </div>
            </div>
            <div class="maps-area" id="mapsArea">
                <div class="message ai-message">
                    <strong>🗺️ ENHANCED Location Intelligence Services</strong><br><br>
                    <strong>🌍 OpenStreetMap</strong> - Free community-driven maps<br>
                    <strong>🍃 Leaflet</strong> - Lightweight open source library<br>
                    <strong>🤖 AI Location Analysis</strong> - Extract location from websites<br>
                    <strong>🏢 Website Location</strong> - Analyze business locations from URLs<br>
                    <strong>🔍 Puppeteer Enhanced</strong> - Real data extraction + mapping<br><br>
                    Try: "coffee shops London", "tech companies San Francisco", or any website URL!
                </div>
                <div id="mapDemo" class="map-container" style="display: none;"></div>
            </div>
            <div class="loading" id="mapsLoading">Analyzing location data...</div>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <!-- Leaflet JS -->
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script>
        const socket = io();
        let sessionId = 'session_' + Date.now();
        let map = null;
        let mapInitialized = false;

        // Socket event handlers
        socket.on('message_response', (data) => {
            addMessage(data.message, 'ai', data.model, 'chatArea');
        });

        socket.on('typing', (isTyping) => {
            document.getElementById('typingIndicator').style.display = isTyping ? 'block' : 'none';
        });

        socket.on('extraction_result', (data) => {
            hideLoading('analysis');
            const area = document.getElementById('analysisArea');
            if (data.success) {
                displayEnhancedAnalysis(data, area);
            } else {
                addMessage('❌ Analysis failed: ' + data.error, 'error', null, 'analysisArea');
            }
        });

        socket.on('analysis_result', (data) => {
            hideLoading('analysis');
            const area = document.getElementById('analysisArea');
            if (data.success) {
                addMessage('⚡ Quick Analysis Complete:', 'success', null, 'analysisArea');
                addMessage('<div class="report-content">' + data.analysis + '</div>', 'ai', data.model, 'analysisArea');
            } else {
                addMessage('❌ Analysis failed: ' + data.error, 'error', null, 'analysisArea');
            }
        });

        socket.on('report_result', (data) => {
            hideLoading('analysis');
            const area = document.getElementById('analysisArea');
            if (data.success) {
                addMessage('📊 Business Report Generated:', 'success', null, 'analysisArea');
                addMessage('<div class="report-content">' + data.report + '</div>', 'ai', data.model, 'analysisArea');
            } else {
                addMessage('❌ Report failed: ' + data.error, 'error', null, 'analysisArea');
            }
        });

        socket.on('enhanced_analysis_result', (data) => {
            hideLoading('analysis');
            const area = document.getElementById('analysisArea');
            if (data.success) {
                displayEnhancedAnalysis(data, area);
            } else {
                addMessage('❌ Enhanced analysis failed: ' + data.error, 'error', null, 'analysisArea');
            }
        });

        socket.on('search_results', (data) => {
            hideLoading('search');
            const area = document.getElementById('searchArea');
            if (data.success) {
                addMessage('🔍 Search Results:', 'success', null, 'searchArea');
                data.results.forEach((result, index) => {
                    let resultHtml = '<div class="search-result">';
                    if (result.url) {
                        resultHtml += '<strong><a href="' + result.url + '" target="_blank">' + (result.title || result.url) + '</a></strong><br>';
                    } else {
                        resultHtml += '<strong>' + (result.title || 'Result ' + (index + 1)) + '</strong><br>';
                    }
                    if (result.snippet) {
                        resultHtml += '<p>' + result.snippet + '</p>';
                    }
                    resultHtml += '</div>';
                    addMessage(resultHtml, 'ai', null, 'searchArea');
                });
            } else {
                addMessage('❌ Search failed: ' + data.error, 'error', null, 'searchArea');
            }
        });

        socket.on('search_analysis_results', (data) => {
            hideLoading('search');
            const area = document.getElementById('searchArea');
            if (data.success) {
                addMessage('🤖 Search & Analysis Complete for: "' + data.searchQuery + '"', 'success', null, 'searchArea');
                
                data.analysisResults.forEach((result, index) => {
                    let resultHtml = '<div class="search-result">';
                    if (result.searchResult.url) {
                        resultHtml += '<strong><a href="' + result.searchResult.url + '" target="_blank">' + (result.searchResult.title || result.searchResult.url) + '</a></strong>';
                        if (result.method) {
                            resultHtml += ' <span class="extraction-badge">' + result.method + '</span>';
                        }
                        resultHtml += '<br>';
                    } else {
                        resultHtml += '<strong>' + (result.searchResult.title || 'Result ' + (index + 1)) + '</strong><br>';
                    }
                    
                    if (result.analysis && result.analysis.success) {
                        resultHtml += '<div class="report-content">' + result.analysis.analysis + '</div>';
                    } else if (result.error) {
                        resultHtml += '<div class="error-message">Analysis failed: ' + result.error + '</div>';
                    }
                    
                    resultHtml += '</div>';
                    addMessage(resultHtml, 'ai', null, 'searchArea');
                });
            } else {
                addMessage('❌ Search and analysis failed: ' + data.error, 'error', null, 'searchArea');
            }
        });

        socket.on('location_results', (data) => {
            hideLoading('maps');
            const area = document.getElementById('mapsArea');
            if (data.success) {
                addMessage('🗺️ Location Results:', 'success', null, 'mapsArea');
                
                if (data.website) {
                    // Website location analysis results
                    addMessage('<div class="location-result"><strong>Website:</strong> ' + data.website + '</div>', 'info', null, 'mapsArea');
                    addMessage('<div class="report-content"><strong>Location Analysis:</strong><br>' + data.locationAnalysis + '</div>', 'ai', null, 'mapsArea');
                    
                    if (data.suggestedLocations) {
                        addMessage('<div class="location-result"><strong>Suggested Locations to Map:</strong><br>' + data.suggestedLocations + '</div>', 'info', null, 'mapsArea');
                    }
                } else {
                    // Regular location results
                    data.results.forEach((result, index) => {
                        let resultHtml = '<div class="location-result">';
                        
                        if (result.name) {
                            resultHtml += '<strong>' + result.name + '</strong><br>';
                        }
                        
                        if (result.lat && result.lon) {
                            resultHtml += '<strong>Coordinates:</strong> ' + result.lat + ', ' + result.lon + '<br>';
                            resultHtml += '<button onclick="showOnMap(' + result.lat + ', ' + result.lon + ', \\'' + result.name.replace(/'/g, "\\'") + '\\')">Show on Map</button><br>';
                        }
                        
                        if (result.address) {
                            resultHtml += '<strong>Address:</strong> ' + JSON.stringify(result.address) + '<br>';
                        }
                        
                        if (result.analysis) {
                            resultHtml += '<div class="report-content">' + result.analysis + '</div>';
                        }
                        
                        if (result.type) {
                            resultHtml += '<strong>Type:</strong> ' + result.type + '<br>';
                        }
                        
                        resultHtml += '</div>';
                        addMessage(resultHtml, 'ai', null, 'mapsArea');
                    });
                }
            } else {
                addMessage('❌ Location search failed: ' + data.error, 'error', null, 'mapsArea');
            }
        });

        socket.on('error', (error) => {
            hideLoading('analysis');
            hideLoading('search');
            hideLoading('maps');
            addMessage('❌ Error: ' + error, 'error', null, 'analysisArea');
            addMessage('❌ Error: ' + error, 'error', null, 'searchArea');
            addMessage('❌ Error: ' + error, 'error', null, 'mapsArea');
        });

        function displayEnhancedAnalysis(data, area) {
            let html = '';
            
            html += '<div class="message success-message">';
            html += '✅ Enhanced Analysis Complete! ';
            html += '<span class="extraction-badge">' + (data.method || 'AI') + '</span>';
            html += '</div>';
            
            if (data.extraction && data.extraction.screenshot) {
                html += '<div class="message info-message">';
                html += '<strong>📸 Website Screenshot:</strong><br>';
                html += '<img src="data:image/png;base64,' + data.extraction.screenshot + '" class="screenshot" alt="Website screenshot">';
                html += '</div>';
            }
            
            if (data.combinedData) {
                const cd = data.combinedData;
                
                html += '<div class="contact-info"><strong>Title:</strong> ' + cd.title + '</div>';
                html += '<div class="contact-info"><strong>Description:</strong> ' + cd.description + '</div>';
                
                if (cd.contacts.phones && cd.contacts.phones.length > 0) {
                    html += '<div class="contact-info"><strong>📞 Phone Numbers Found:</strong><div class="data-grid">';
                    cd.contacts.phones.forEach(num => {
                        html += '<div class="data-item">' + num + '</div>';
                    });
                    html += '</div></div>';
                }
                
                if (cd.contacts.emails && cd.contacts.emails.length > 0) {
                    html += '<div class="contact-info"><strong>📧 Emails Found:</strong><div class="data-grid">';
                    cd.contacts.emails.forEach(email => {
                        html += '<div class="data-item">' + email + '</div>';
                    });
                    html += '</div></div>';
                }
                
                if (cd.contacts.addresses && cd.contacts.addresses.length > 0) {
                    html += '<div class="contact-info"><strong>📍 Addresses Found:</strong><div class="data-grid">';
                    cd.contacts.addresses.forEach(addr => {
                        html += '<div class="data-item">' + addr + '</div>';
                    });
                    html += '</div></div>';
                }
                
                if (cd.social && cd.social.length > 0) {
                    html += '<div class="contact-info"><strong>🔗 Social Links:</strong><div class="data-grid">';
                    cd.social.forEach(link => {
                        html += '<div class="data-item"><a href="' + link + '" target="_blank">' + link + '</a></div>';
                    });
                    html += '</div></div>';
                }
            }
            
            if (data.aiAnalysis && data.aiAnalysis.content) {
                html += '<div class="message info-message">';
                html += '<strong>🤖 AI Business Intelligence:</strong>';
                html += '<div class="report-content">' + data.aiAnalysis.content + '</div>';
                html += '</div>';
            }
            
            addMessage(html, 'ai', null, 'analysisArea');
        }

        function showLoading(type) {
            document.getElementById(type + 'Loading').style.display = 'block';
        }

        function hideLoading(type) {
            document.getElementById(type + 'Loading').style.display = 'none';
        }

        // Tab management
        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabName + '-tab').classList.add('active');
        }

        // Chat functions
        function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            const model = document.getElementById('modelSelect').value;

            if (!message) return;

            input.value = '';
            addMessage(message, 'user', null, 'chatArea');

            socket.emit('send_message', {
                message: message,
                model: model,
                sessionId: sessionId
            });
        }

        function handleKeyPress(event) {
            if (event.key === 'Enter') {
                sendMessage();
            }
        }

        // Analysis functions
        function analyzeWebsite() {
            const url = document.getElementById('websiteUrl').value.trim();
            const model = document.getElementById('analysisModel').value;
            if (!url) return alert('Please enter a website');

            showLoading('analysis');
            socket.emit('extract_website', { url: url, model: model });
        }

        function quickAnalysis() {
            const url = document.getElementById('websiteUrl').value.trim();
            const model = document.getElementById('analysisModel').value;
            
            if (!url) return alert('Please enter a website');

            showLoading('analysis');
            socket.emit('quick_analysis', { 
                url: url, 
                model: model 
            });
        }

        function generateBusinessReport() {
            const url = document.getElementById('websiteUrl').value.trim();
            const model = document.getElementById('analysisModel').value;
            
            if (!url) return alert('Please enter a website');

            showLoading('analysis');
            socket.emit('generate_report', { 
                url: url, 
                model: model 
            });
        }

        function enhancedAnalysis() {
            const url = document.getElementById('websiteUrl').value.trim();
            if (!url) return alert('Please enter a website');

            showLoading('analysis');
            socket.emit('enhanced_analysis', { 
                url: url
            });
        }

        // Search functions
        function performSearch() {
            const query = document.getElementById('searchQuery').value.trim();
            const model = document.getElementById('searchModel').value;
            
            if (!query) return alert('Please enter a search query');

            showLoading('search');
            socket.emit('perform_search', { 
                query: query, 
                model: model 
            });
        }

        function searchAndAnalyze() {
            const query = document.getElementById('searchQuery').value.trim();
            const model = document.getElementById('searchModel').value;
            
            if (!query) return alert('Please enter a search query');

            showLoading('search');
            socket.emit('search_and_analyze', { 
                query: query, 
                model: model 
            });
        }

        function enhancedSearchAnalyze() {
            const query = document.getElementById('searchQuery').value.trim();
            if (!query) return alert('Please enter a search query');

            showLoading('search');
            socket.emit('enhanced_search_analyze', { 
                query: query
            });
        }

        // Map functions
        function searchLocation() {
            const query = document.getElementById('locationQuery').value.trim();
            const service = document.getElementById('mapService').value;
            
            if (!query) return alert('Please enter a location, business, or website');

            showLoading('maps');
            socket.emit('search_location', { 
                query: query, 
                service: service 
            });
        }

        function analyzeWebsiteLocation() {
            const query = document.getElementById('locationQuery').value.trim();
            if (!query) return alert('Please enter a website URL');

            showLoading('maps');
            socket.emit('search_location', { 
                query: query, 
                service: 'ai' 
            });
        }

        function showMapDemo() {
            const mapDemo = document.getElementById('mapDemo');
            mapDemo.style.display = 'block';
            
            if (!mapInitialized) {
                // Initialize Leaflet map
                map = L.map('mapDemo').setView([40.7128, -74.0060], 12);
                
                // Add OpenStreetMap tiles
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© OpenStreetMap contributors',
                    maxZoom: 19
                }).addTo(map);
                
                // Add a marker
                L.marker([40.7128, -74.0060]).addTo(map)
                    .bindPopup('Hello World! <br> This is OpenStreetMap + Leaflet<br>Completely free and open source!')
                    .openPopup();
                
                mapInitialized = true;
            }
            
            addMessage('🌍 Map Demo Loaded with OpenStreetMap + Leaflet', 'success', null, 'mapsArea');
        }

        function showOnMap(lat, lon, name) {
            const mapDemo = document.getElementById('mapDemo');
            mapDemo.style.display = 'block';
            
            if (!mapInitialized) {
                map = L.map('mapDemo').setView([lat, lon], 13);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© OpenStreetMap contributors',
                    maxZoom: 19
                }).addTo(map);
                mapInitialized = true;
            } else {
                map.setView([lat, lon], 13);
            }
            
            // Clear existing markers and add new one
            map.eachLayer((layer) => {
                if (layer instanceof L.Marker) {
                    map.removeLayer(layer);
                }
            });
            
            L.marker([lat, lon]).addTo(map)
                .bindPopup('<strong>' + (name || 'Location') + '</strong><br>Lat: ' + lat + ', Lon: ' + lon)
                .openPopup();
        }

        // Utility functions
        function addMessage(text, sender, model, areaId) {
            const area = document.getElementById(areaId);
            const messageDiv = document.createElement('div');
            
            let className = 'message ';
            if (sender === 'error') {
                className += 'error-message';
            } else if (sender === 'success') {
                className += 'success-message';
            } else if (sender === 'info') {
                className += 'info-message';
            } else if (sender === 'user') {
                className += 'user-message';
            } else {
                className += 'ai-message';
            }
            
            messageDiv.className = className;
            
            let content = text;
            if (model && sender === 'ai') {
                content += '<div style="margin-top: 8px; font-size: 0.8em; color: #666;">';
                content += '<strong>Model:</strong> <span class="model-badge">' + model + '</span>';
                content += '</div>';
            }
            
            messageDiv.innerHTML = content;
            area.appendChild(messageDiv);
            area.scrollTop = area.scrollHeight;
        }

        function clearChat() {
            document.getElementById('chatArea').innerHTML = '<div class="message ai-message">Chat cleared. Start a new conversation.</div>';
            sessionId = 'session_' + Date.now();
        }

        // Initialize
        socket.emit('get_models');
    </script>
</body>
</html>`;
    res.send(html);
});

// ========== ALL YOUR EXISTING API ROUTES AND FUNCTIONS GO HERE ==========
// [Keep all your existing code exactly as it was...]

// ========== START SERVER ==========
async function startServer() {
    await initBrowser();
    await fetchModels();
    
    server.listen(PORT, () => {
        console.log('🚀 AI Business Analysis App Started!');
        console.log('📍 http://localhost:' + PORT);
        console.log('📊 Features: AI Chat + Business Analysis + Web Search + Location Intelligence');
        console.log('🔍 Puppeteer: Real website data extraction');
        console.log('🤖 AI Intelligence: Business insights and patterns');
        console.log('🗺️ Maps: OpenStreetMap + Leaflet (no Google Maps API)');
        console.log('🤖 Available models:', availableModels.length);
        console.log('✅ Root route fixed - No more "Cannot GET /" errors!');
        
        if (!SERPAPI_KEY) {
            console.log('💡 Tip: Add SERPAPI_KEY to .env for enhanced web search');
        }
        if (!GOOGLE_CSE_ID || !GOOGLE_API_KEY) {
            console.log('💡 Tip: Add GOOGLE_CSE_ID and GOOGLE_API_KEY to .env for Google Custom Search');
        }
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    if (browserInstance) {
        await browserInstance.close();
    }
    process.exit(0);
});

startServer();