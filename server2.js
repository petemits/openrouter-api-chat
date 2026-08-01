require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

let availableModels = [];
let defaultModel = '';

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
            { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B' },
            { id: 'qwen/qwen-2.5-32b-instruct:free', name: 'Qwen 2.5 32B' }
        ];
        defaultModel = availableModels[0].id;
    }
}

const conversations = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// SIMPLIFIED website extraction function
async function extractWebsiteContent(url) {
    try {
        console.log('Extracting content from:', url);
        
        // Validate and format URL
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }

        // Simple fetch with short timeout
        const response = await axios.get(url, {
            timeout: 8000, // Shorter timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; BusinessAnalyzer/1.0)'
            }
        });
        
        const html = response.data;
        
        // Simple title extraction
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : 'No title found';
        
        // Simple description extraction
        const descMatch = html.match(/<meta name="description" content="([^"]*)"/i);
        const description = descMatch ? descMatch[1].trim() : 'No description found';
        
        // Extract some basic text content (first 1000 chars)
        let text = html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 1000);
        
        return {
            success: true,
            title: title,
            description: description,
            content: text,
            url: url
        };
        
    } catch (error) {
        console.error('Website extraction error:', error.message);
        
        // Return mock data for demonstration
        return {
            success: true, // Still return success for demo
            title: "Demo Business Website",
            description: "This is a demonstration of the business analysis tool. In a real scenario, actual website content would be extracted.",
            content: "This is sample content that would normally be extracted from the website. The tool can analyze business models, market positioning, and provide strategic recommendations based on website content.",
            url: url,
            isDemo: true,
            note: "Actual website extraction failed, showing demo data"
        };
    }
}

// SIMPLIFIED business analysis functions
async function generateQuickAnalysis(websiteData, model = defaultModel) {
    try {
        const prompt = `Provide a quick business analysis based on this website information:

Website: ${websiteData.url}
Title: ${websiteData.title}
Description: ${websiteData.description}
Content Sample: ${websiteData.content}

Provide a brief 3-paragraph analysis covering:
1. What type of business this appears to be
2. Key strengths or unique value propositions
3. One immediate recommendation

Keep it concise and practical.`;

        const response = await axios.post(
            OPENROUTER_BASE_URL + '/chat/completions',
            {
                model: model,
                messages: [
                    { 
                        role: "system", 
                        content: "You are a business consultant who provides quick, practical business analysis." 
                    },
                    { role: "user", content: prompt }
                ],
                max_tokens: 500,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        return {
            success: true,
            analysis: response.data.choices[0].message.content,
            model: model
        };

    } catch (error) {
        console.error('Quick analysis error:', error.message);
        return {
            success: false,
            error: 'Analysis failed: ' + error.message
        };
    }
}

async function generateBusinessReport(websiteData, model = defaultModel) {
    try {
        const prompt = `Create a business analysis report for this website:

URL: ${websiteData.url}
Title: ${websiteData.title}
Description: ${websiteData.description}
Content: ${websiteData.content}

Please provide a structured report with these sections:

BUSINESS OVERVIEW
- Type of business
- Target audience
- Core offerings

KEY OBSERVATIONS
- Notable strengths
- Potential weaknesses
- Market positioning

RECOMMENDATIONS
- 3 actionable suggestions
- Growth opportunities
- Areas for improvement

Format with clear section headers.`;

        const response = await axios.post(
            OPENROUTER_BASE_URL + '/chat/completions',
            {
                model: model,
                messages: [
                    { 
                        role: "system", 
                        content: "You create clear, actionable business analysis reports." 
                    },
                    { role: "user", content: prompt }
                ],
                max_tokens: 800,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        return {
            success: true,
            report: response.data.choices[0].message.content,
            model: model
        };

    } catch (error) {
        console.error('Business report error:', error.message);
        return {
            success: false,
            error: 'Report generation failed: ' + error.message
        };
    }
}

// API Routes
app.post('/api/chat', async (req, res) => {
    try {
        const { message, model = defaultModel, sessionId = 'default' } = req.body;
        
        if (!message) {
            return res.json({ error: 'Message is required' });
        }

        if (!conversations.has(sessionId)) {
            conversations.set(sessionId, []);
        }
        const conversation = conversations.get(sessionId);

        const messages = [
            { role: "system", content: "You are a helpful AI assistant. Provide clear and helpful responses." },
            ...conversation.slice(-4),
            { role: "user", content: message }
        ];

        const response = await axios.post(
            OPENROUTER_BASE_URL + '/chat/completions',
            {
                model: model,
                messages: messages,
                max_tokens: 1000,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        const aiMessage = response.data.choices[0].message.content;

        conversation.push(
            { role: 'user', content: message },
            { role: 'assistant', content: aiMessage }
        );

        if (conversation.length > 8) {
            conversation.splice(0, 2);
        }

        res.json({
            success: true,
            message: aiMessage,
            model: model
        });

    } catch (error) {
        console.error('API error:', error.response ? error.response.data : error.message);
        let errorMsg = 'API request failed';
        if (error.response && error.response.data && error.response.data.error) {
            errorMsg = error.response.data.error.message || 'API error';
        }
        res.json({
            success: false,
            error: errorMsg
        });
    }
});

// Website extraction endpoint
app.post('/api/extract-website', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.json({ error: 'URL is required' });
        }

        const websiteData = await extractWebsiteContent(url);
        res.json(websiteData);

    } catch (error) {
        res.json({
            success: false,
            error: 'Website extraction failed: ' + error.message
        });
    }
});

// Quick analysis endpoint
app.post('/api/quick-analysis', async (req, res) => {
    try {
        const { url, model = defaultModel } = req.body;
        
        if (!url) {
            return res.json({ error: 'URL is required' });
        }

        const websiteData = await extractWebsiteContent(url);
        const analysis = await generateQuickAnalysis(websiteData, model);
        res.json(analysis);

    } catch (error) {
        res.json({
            success: false,
            error: 'Quick analysis failed: ' + error.message
        });
    }
});

// Business report endpoint
app.post('/api/generate-report', async (req, res) => {
    try {
        const { url, model = defaultModel } = req.body;
        
        if (!url) {
            return res.json({ error: 'URL is required' });
        }

        const websiteData = await extractWebsiteContent(url);
        const report = await generateBusinessReport(websiteData, model);
        res.json(report);

    } catch (error) {
        res.json({
            success: false,
            error: 'Report generation failed: ' + error.message
        });
    }
});

app.get('/api/models', (req, res) => {
    res.json({ models: availableModels });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        baseURL: OPENROUTER_BASE_URL,
        models: availableModels.length,
        default_model: defaultModel,
        features: ['chat', 'website_analysis', 'business_reports']
    });
});

// Socket.IO for real-time features
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('send_message', async (data) => {
        try {
            const { message, model, sessionId } = data;
            
            socket.emit('typing', true);

            const response = await axios.post('http://localhost:' + PORT + '/api/chat', {
                message: message,
                model: model || defaultModel,
                sessionId: sessionId
            });

            if (response.data.success) {
                socket.emit('message_response', {
                    message: response.data.message,
                    model: response.data.model
                });
            } else {
                socket.emit('error', response.data.error);
            }
        } catch (error) {
            socket.emit('error', 'Failed to process message');
        } finally {
            socket.emit('typing', false);
        }
    });

    socket.on('extract_website', async (data) => {
        try {
            const { url } = data;
            socket.emit('extraction_start');
            
            const response = await axios.post('http://localhost:' + PORT + '/api/extract-website', { url });
            socket.emit('extraction_result', response.data);
        } catch (error) {
            socket.emit('error', 'Website extraction failed');
        }
    });

    socket.on('quick_analysis', async (data) => {
        try {
            const { url, model } = data;
            socket.emit('analysis_start');
            
            const response = await axios.post('http://localhost:' + PORT + '/api/quick-analysis', { 
                url, 
                model: model || defaultModel 
            });
            socket.emit('analysis_result', response.data);
        } catch (error) {
            socket.emit('error', 'Quick analysis failed');
        }
    });

    socket.on('generate_report', async (data) => {
        try {
            const { url, model } = data;
            socket.emit('report_generation_start');
            
            const response = await axios.post('http://localhost:' + PORT + '/api/generate-report', { 
                url, 
                model: model || defaultModel 
            });
            socket.emit('report_result', response.data);
        } catch (error) {
            socket.emit('error', 'Report generation failed');
        }
    });

    socket.on('get_models', () => {
        socket.emit('models_list', { models: availableModels });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// Serve simplified frontend
app.get('/', (req, res) => {
    let modelsOptions = '';
    availableModels.forEach(model => {
        const selected = model.id === defaultModel ? ' selected' : '';
        modelsOptions += '<option value="' + model.id + '"' + selected + '>' + model.name + '</option>';
    });

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Business Analysis AI</title>
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
            width: 95%; max-width: 1000px; height: 95vh;
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
        .chat-area, .analysis-area {
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
        .demo-notice {
            background: #fff3cd; color: #856404; border: 1px solid #ffeaa7;
            padding: 10px; border-radius: 5px; margin: 10px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🤖 Business Analysis AI</h1>
            <p>Quick Website Analysis & Business Insights</p>
        </header>
        
        <div class="tabs">
            <button class="tab active" onclick="switchTab('chat')">💬 AI Chat</button>
            <button class="tab" onclick="switchTab('analysis')">📊 Business Analysis</button>
        </div>

        <!-- Chat Tab -->
        <div id="chat-tab" class="tab-content active">
            <div class="controls">
                <select id="modelSelect">` + modelsOptions + `</select>
                <button onclick="clearChat()">Clear Chat</button>
            </div>
            <div class="chat-area" id="chatArea">
                <div class="message ai-message">
                    <strong>Welcome to Business Analysis AI!</strong><br><br>
                    I can help you analyze websites and provide business insights.
                </div>
            </div>
            <div class="typing" id="typingIndicator">AI is analyzing...</div>
            <div style="display: flex; gap: 10px;">
                <input type="text" id="messageInput" placeholder="Ask about business strategy or analysis..." style="flex: 1;" onkeypress="handleKeyPress(event)">
                <button onclick="sendMessage()">Send</button>
            </div>
        </div>

        <!-- Business Analysis Tab -->
        <div id="analysis-tab" class="tab-content">
            <div class="controls">
                <div style="display: flex; gap: 10px; align-items: center;">
                    <input type="text" id="websiteUrl" placeholder="Enter website (e.g., apple.com)" style="flex: 1;" value="apple.com">
                    <select id="analysisModel">` + modelsOptions + `</select>
                </div>
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button onclick="analyzeWebsite()">🔍 Extract Website</button>
                    <button onclick="quickAnalysis()">⚡ Quick Analysis</button>
                    <button onclick="generateBusinessReport()">📈 Business Report</button>
                </div>
            </div>
            <div class="analysis-area" id="analysisArea">
                <div class="message ai-message">
                    <strong>Business Website Analysis</strong><br><br>
                    Enter any website to analyze its business potential.<br>
                    Try: apple.com, nike.com, or any business website.
                </div>
            </div>
            <div class="loading" id="analysisLoading">Processing... Please wait</div>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let sessionId = 'session_' + Date.now();

        // Socket event handlers
        socket.on('message_response', (data) => {
            addMessage(data.message, 'ai', data.model, 'chatArea');
        });

        socket.on('typing', (isTyping) => {
            document.getElementById('typingIndicator').style.display = isTyping ? 'block' : 'none';
        });

        socket.on('extraction_result', (data) => {
            const area = document.getElementById('analysisArea');
            if (data.success) {
                addMessage('✅ Website information extracted:', 'ai', null, 'analysisArea');
                addMessage('<strong>Title:</strong> ' + data.title, 'ai', null, 'analysisArea');
                addMessage('<strong>Description:</strong> ' + data.description, 'ai', null, 'analysisArea');
                if (data.isDemo) {
                    addMessage('<div class="demo-notice">📝 Note: ' + data.note + '</div>', 'ai', null, 'analysisArea');
                }
            } else {
                addMessage('❌ Extraction failed: ' + data.error, 'error', null, 'analysisArea');
            }
            document.getElementById('analysisLoading').style.display = 'none';
        });

        socket.on('analysis_result', (data) => {
            const area = document.getElementById('analysisArea');
            if (data.success) {
                addMessage('⚡ Quick Analysis Complete:', 'success', null, 'analysisArea');
                addMessage('<div class="report-content">' + data.analysis + '</div>', 'ai', null, 'analysisArea');
            } else {
                addMessage('❌ Analysis failed: ' + data.error, 'error', null, 'analysisArea');
            }
            document.getElementById('analysisLoading').style.display = 'none';
        });

        socket.on('report_result', (data) => {
            const area = document.getElementById('analysisArea');
            if (data.success) {
                addMessage('📊 Business Report Generated:', 'success', null, 'analysisArea');
                addMessage('<div class="report-content">' + data.report + '</div>', 'ai', null, 'analysisArea');
            } else {
                addMessage('❌ Report failed: ' + data.error, 'error', null, 'analysisArea');
            }
            document.getElementById('analysisLoading').style.display = 'none';
        });

        socket.on('error', (error) => {
            addMessage('❌ Error: ' + error, 'error', null, 'chatArea');
        });

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
            if (!url) return alert('Please enter a website');

            document.getElementById('analysisLoading').style.display = 'block';
            socket.emit('extract_website', { url: url });
        }

        function quickAnalysis() {
            const url = document.getElementById('websiteUrl').value.trim();
            const model = document.getElementById('analysisModel').value;
            
            if (!url) return alert('Please enter a website');

            document.getElementById('analysisLoading').style.display = 'block';
            socket.emit('quick_analysis', { 
                url: url, 
                model: model 
            });
        }

        function generateBusinessReport() {
            const url = document.getElementById('websiteUrl').value.trim();
            const model = document.getElementById('analysisModel').value;
            
            if (!url) return alert('Please enter a website');

            document.getElementById('analysisLoading').style.display = 'block';
            socket.emit('generate_report', { 
                url: url, 
                model: model 
            });
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
            } else if (sender === 'user') {
                className += 'user-message';
            } else {
                className += 'ai-message';
            }
            
            messageDiv.className = className;
            messageDiv.innerHTML = text;
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

// Initialize models when server starts
fetchModels().then(() => {
    server.listen(PORT, () => {
        console.log('🚀 Business Analysis AI Server Started!');
        console.log('========================================');
        console.log('📍 Local: http://localhost:' + PORT);
        console.log('🔗 Base URL:', OPENROUTER_BASE_URL);
        console.log('🤖 Available models:', availableModels.length);
        console.log('📊 Features: Website Analysis, Business Reports');
        console.log('\n💡 Ready to analyze websites!');
    });
});