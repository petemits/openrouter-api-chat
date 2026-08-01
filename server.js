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
            // Filter for free models
            const freeModels = response.data.data.filter(model => 
                model.id.includes(':free') || 
                (model.pricing && model.pricing.prompt === '0' && model.pricing.completion === '0')
            );

            availableModels = freeModels.map(model => ({
                id: model.id,
                name: model.name || model.id,
                description: model.description || 'AI Model'
            })).slice(0, 10); // Limit to 10 models

            // Set default model
            if (availableModels.length > 0) {
                defaultModel = availableModels[0].id;
                console.log('Found', availableModels.length, 'free models');
                console.log('Default model set to:', defaultModel);
            } else {
                // Fallback models if no free ones found
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
        // Fallback models
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
app.use(express.json());

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

        console.log('Sending to OpenRouter with model:', model);
        
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
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'http://localhost:' + PORT,
                    'X-Title': 'AI Chat App'
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

app.get('/api/models', (req, res) => {
    res.json({ models: availableModels });
});

app.get('/health', async (req, res) => {
    try {
        const testResponse = await axios.get(
            OPENROUTER_BASE_URL + '/models',
            {
                headers: {
                    'Authorization': 'Bearer ' + OPENROUTER_API_KEY
                },
                timeout: 5000
            }
        );
        
        res.json({ 
            status: 'OK', 
            baseURL: OPENROUTER_BASE_URL,
            models: availableModels.length,
            api_connected: true,
            default_model: defaultModel
        });
    } catch (error) {
        res.json({ 
            status: 'OK', 
            baseURL: OPENROUTER_BASE_URL,
            models: availableModels.length,
            api_connected: false,
            default_model: defaultModel
        });
    }
});

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

    socket.on('get_models', () => {
        socket.emit('models_list', { models: availableModels });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

app.get('/', (req, res) => {
    let modelsOptions = '';
    availableModels.forEach(model => {
        const selected = model.id === defaultModel ? ' selected' : '';
        modelsOptions += '<option value="' + model.id + '"' + selected + '>' + model.name + '</option>';
    });

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>OpenRouter Chat</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: Arial, sans-serif;
            background: #667eea;
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .container {
            width: 95%; max-width: 800px; height: 95vh;
            background: white; border-radius: 10px;
            display: flex; flex-direction: column;
        }
        header {
            background: #2c3e50; color: white; padding: 15px;
            text-align: center; border-radius: 10px 10px 0 0;
        }
        .controls {
            background: #34495e; padding: 10px; text-align: center;
        }
        select, button {
            padding: 8px 12px; margin: 0 5px; border: none; border-radius: 5px;
        }
        .chat-area {
            flex: 1; padding: 20px; overflow-y: auto;
            background: #f8f9fa;
        }
        .message {
            margin: 10px 0; padding: 10px 15px; border-radius: 10px;
            max-width: 80%;
        }
        .user-message {
            background: #007bff; color: white; margin-left: auto;
        }
        .ai-message {
            background: white; border: 1px solid #ddd;
        }
        .input-area {
            padding: 15px; background: white;
            border-top: 1px solid #ddd; display: flex;
        }
        #messageInput {
            flex: 1; padding: 12px; border: 1px solid #ddd;
            border-radius: 5px; margin-right: 10px;
        }
        #sendButton {
            background: #007bff; color: white; padding: 12px 20px;
            border: none; border-radius: 5px; cursor: pointer;
        }
        .typing {
            color: #666; font-style: italic; padding: 10px;
            display: none;
        }
        .model-badge {
            background: #3498db; color: white; padding: 2px 6px;
            border-radius: 8px; font-size: 0.8em; margin-left: 5px;
        }
        .error-message {
            background: #ffebee; color: #c62828; border-color: #f44336;
        }
        .status {
            font-size: 0.9em; opacity: 0.8; margin-top: 5px;
        }
        .loading {
            color: #666; text-align: center; padding: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>OpenRouter AI Chat</h1>
            <p>Base URL: ` + OPENROUTER_BASE_URL + `</p>
            <p class="status">Loaded ` + availableModels.length + ` free models</p>
        </header>
        
        <div class="controls">
            <select id="modelSelect">` + modelsOptions + `</select>
            <button onclick="clearChat()">Clear Chat</button>
        </div>

        <div class="chat-area" id="chatArea">
            <div class="message ai-message">
                Welcome! Using <strong>` + defaultModel + `</strong> as default model.
            </div>
        </div>

        <div class="typing" id="typingIndicator">
            AI is typing...
        </div>

        <div class="input-area">
            <input type="text" id="messageInput" placeholder="Type your message..." onkeypress="handleKeyPress(event)">
            <button id="sendButton" onclick="sendMessage()">Send</button>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let sessionId = 'session_' + Date.now();

        socket.on('message_response', (data) => {
            addMessage(data.message, 'ai', data.model);
        });

        socket.on('typing', (isTyping) => {
            document.getElementById('typingIndicator').style.display = isTyping ? 'block' : 'none';
        });

        socket.on('error', (error) => {
            addMessage('Error: ' + error, 'error');
        });

        socket.on('models_list', (data) => {
            console.log('Available models:', data.models);
        });

        // Request models list on connect
        socket.emit('get_models');

        function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            const model = document.getElementById('modelSelect').value;

            if (!message) return;

            input.value = '';
            addMessage(message, 'user');

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

        function addMessage(text, sender, model) {
            const chatArea = document.getElementById('chatArea');
            const messageDiv = document.createElement('div');
            
            if (sender === 'error') {
                messageDiv.className = 'message ai-message error-message';
            } else {
                messageDiv.className = 'message ' + (sender === 'user' ? 'user-message' : 'ai-message');
            }
            
            let content = text;
            if (model && sender === 'ai') {
                content += '<span class="model-badge">' + getModelName(model) + '</span>';
            }
            
            messageDiv.innerHTML = content;
            chatArea.appendChild(messageDiv);
            chatArea.scrollTop = chatArea.scrollHeight;
        }

        function getModelName(modelId) {
            // Extract a shorter name from the model ID
            const parts = modelId.split('/');
            const name = parts[parts.length - 1].split(':')[0];
            return name.charAt(0).toUpperCase() + name.slice(1);
        }

        function clearChat() {
            document.getElementById('chatArea').innerHTML = '<div class="message ai-message">Chat cleared. Start a new conversation.</div>';
            sessionId = 'session_' + Date.now();
        }
    </script>
</body>
</html>`;

    res.send(html);
});

// Initialize models when server starts
fetchModels().then(() => {
    server.listen(PORT, () => {
        console.log('OpenRouter Chat Server running on port', PORT);
        console.log('Base URL:', OPENROUTER_BASE_URL);
        console.log('Available free models:', availableModels.length);
        availableModels.forEach(model => {
            console.log('  -', model.name, '(', model.id, ')');
        });
        console.log('Default model:', defaultModel);
        console.log('\nOpen http://localhost:' + PORT);
    });
});