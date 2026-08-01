require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

// Image generation APIs
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;
const STABILITY_API_KEY = process.env.STABILITY_API_KEY;
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;

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

// Website extraction function
async function extractWebsiteContent(url) {
    try {
        console.log('Extracting content from:', url);
        
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const html = response.data;
        
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1] : 'No title found';
        
        let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
        text = text.replace(/<[^>]+>/g, ' ');
        text = text.replace(/\s+/g, ' ').trim().substring(0, 5000);
        
        return {
            success: true,
            title: title,
            content: text,
            url: url
        };
    } catch (error) {
        console.error('Website extraction error:', error.message);
        return {
            success: false,
            error: 'Failed to extract website content: ' + error.message
        };
    }
}

// Generate business report
async function generateBusinessReport(websiteData, model = defaultModel) {
    try {
        const prompt = `Analyze this business website and create a comprehensive business report:

Website: ${websiteData.url}
Title: ${websiteData.title}
Content: ${websiteData.content}

Please provide a structured business analysis report with the following sections:

1. BUSINESS OVERVIEW
2. MARKET ANALYSIS  
3. SWOT ANALYSIS
4. RECOMMENDATIONS

Make the report professional and actionable.`;

        const response = await axios.post(
            OPENROUTER_BASE_URL + '/chat/completions',
            {
                model: model,
                messages: [
                    { role: "system", content: "You are a business analyst expert." },
                    { role: "user", content: prompt }
                ],
                max_tokens: 3000,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 45000
            }
        );

        return {
            success: true,
            report: response.data.choices[0].message.content
        };
    } catch (error) {
        console.error('Business report generation error:', error.message);
        return {
            success: false,
            error: 'Failed to generate business report: ' + error.message
        };
    }
}

// REAL IMAGE GENERATION FUNCTIONS

// 1. Hugging Face Stable Diffusion (Free tier available)
async function generateImageHuggingFace(prompt) {
    try {
        console.log('Generating image with Hugging Face:', prompt);
        
        const response = await fetch(
            "https://api-inference.huggingface.co/models/runwayml/stable-diffusion-v1-5",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${HUGGINGFACE_API_KEY || 'your_huggingface_key'}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    inputs: prompt,
                    options: {
                        wait_for_model: true
                    }
                }),
            }
        );

        if (!response.ok) {
            throw new Error(`Hugging Face API error: ${response.statusText}`);
        }

        const buffer = await response.buffer();
        const base64Image = buffer.toString('base64');
        const imageUrl = `data:image/jpeg;base64,${base64Image}`;

        return {
            success: true,
            imageUrl: imageUrl,
            provider: 'Hugging Face (Stable Diffusion)',
            prompt: prompt
        };
    } catch (error) {
        console.error('Hugging Face image generation error:', error.message);
        return {
            success: false,
            error: 'Hugging Face: ' + error.message,
            provider: 'Hugging Face'
        };
    }
}

// 2. Stability AI (Free tier available)
async function generateImageStability(prompt) {
    try {
        console.log('Generating image with Stability AI:', prompt);
        
        const engineId = "stable-diffusion-xl-1024-v1-0";
        const apiHost = 'https://api.stability.ai';
        
        const response = await fetch(
            `${apiHost}/v1/generation/${engineId}/text-to-image`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Authorization": `Bearer ${STABILITY_API_KEY || 'your_stability_key'}`,
                },
                body: JSON.stringify({
                    text_prompts: [
                        {
                            text: prompt
                        }
                    ],
                    cfg_scale: 7,
                    height: 1024,
                    width: 1024,
                    steps: 30,
                    samples: 1,
                }),
            }
        );

        if (!response.ok) {
            throw new Error(`Stability AI API error: ${response.statusText}`);
        }

        const responseData = await response.json();
        
        if (responseData.artifacts && responseData.artifacts.length > 0) {
            const base64Image = responseData.artifacts[0].base64;
            const imageUrl = `data:image/png;base64,${base64Image}`;

            return {
                success: true,
                imageUrl: imageUrl,
                provider: 'Stability AI',
                prompt: prompt
            };
        } else {
            throw new Error('No image generated');
        }
    } catch (error) {
        console.error('Stability AI image generation error:', error.message);
        return {
            success: false,
            error: 'Stability AI: ' + error.message,
            provider: 'Stability AI'
        };
    }
}

// 3. Replicate (Free credits available)
async function generateImageReplicate(prompt) {
    try {
        console.log('Generating image with Replicate:', prompt);
        
        const response = await fetch("https://api.replicate.com/v1/predictions", {
            method: "POST",
            headers: {
                "Authorization": `Token ${REPLICATE_API_KEY || 'your_replicate_key'}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                version: "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
                input: {
                    prompt: prompt,
                    width: 1024,
                    height: 1024,
                    num_outputs: 1
                }
            }),
        });

        if (!response.ok) {
            throw new Error(`Replicate API error: ${response.statusText}`);
        }

        const prediction = await response.json();
        
        // Poll for result (simplified - in production you'd want proper polling)
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        const resultResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
            headers: {
                "Authorization": `Token ${REPLICATE_API_KEY || 'your_replicate_key'}`,
            },
        });

        const result = await resultResponse.json();
        
        if (result.output && result.output.length > 0) {
            return {
                success: true,
                imageUrl: result.output[0],
                provider: 'Replicate (Stable Diffusion XL)',
                prompt: prompt
            };
        } else {
            throw new Error('Image generation failed');
        }
    } catch (error) {
        console.error('Replicate image generation error:', error.message);
        return {
            success: false,
            error: 'Replicate: ' + error.message,
            provider: 'Replicate'
        };
    }
}

// 4. Fallback: Use OpenRouter's text-to-image if available
async function generateImageOpenRouter(prompt) {
    try {
        console.log('Generating image with OpenRouter:', prompt);
        
        const response = await axios.post(
            OPENROUTER_BASE_URL + '/images/generations',
            {
                model: 'black-forest-labs/flux-1.1-pro',
                prompt: prompt,
                size: '1024x1024',
                n: 1
            },
            {
                headers: {
                    'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            }
        );

        if (response.data && response.data.data && response.data.data.length > 0) {
            return {
                success: true,
                imageUrl: response.data.data[0].url,
                provider: 'OpenRouter (FLUX)',
                prompt: prompt
            };
        } else {
            throw new Error('No image data received');
        }
    } catch (error) {
        console.error('OpenRouter image generation error:', error.message);
        return {
            success: false,
            error: 'OpenRouter: ' + error.message,
            provider: 'OpenRouter'
        };
    }
}

// Main image generation function - tries all available services
async function generateImage(prompt) {
    console.log('Attempting to generate image:', prompt);
    
    // Try services in order of reliability/free tier availability
    const services = [
        generateImageHuggingFace,
        generateImageStability, 
        generateImageOpenRouter,
        generateImageReplicate
    ];

    for (const service of services) {
        try {
            const result = await service(prompt);
            if (result.success) {
                console.log('Image generated successfully with:', result.provider);
                return result;
            }
        } catch (error) {
            console.log(`Service ${service.name} failed:`, error.message);
            continue;
        }
    }

    // If all services fail, provide enhanced prompt for manual use
    const enhancedPrompt = await enhanceImagePrompt(prompt);
    return {
        success: false,
        error: 'All image generation services are currently unavailable. Please try again later or use this enhanced prompt in any AI image generator:',
        enhancedPrompt: enhancedPrompt,
        fallback: true
    };
}

// Enhance image prompts using AI
async function enhanceImagePrompt(basicPrompt) {
    try {
        const response = await axios.post(
            OPENROUTER_BASE_URL + '/chat/completions',
            {
                model: defaultModel,
                messages: [
                    { 
                        role: "system", 
                        content: "You are an expert at creating detailed, vivid image generation prompts. Enhance user prompts with specific details about style, lighting, composition, and mood." 
                    },
                    { 
                        role: "user", 
                        content: `Enhance this image prompt: "${basicPrompt}". Make it detailed and descriptive for AI image generation. Include style, lighting, composition details.` 
                    }
                ],
                max_tokens: 200,
                temperature: 0.8
            },
            {
                headers: {
                    'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        return response.data.choices[0].message.content;
    } catch (error) {
        // Fallback enhancement
        return `High-quality digital artwork of ${basicPrompt}, professional photography, detailed, vibrant colors, masterpiece, 4K resolution`;
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

// Business report generation endpoint
app.post('/api/generate-report', async (req, res) => {
    try {
        const { url, model = defaultModel } = req.body;
        
        if (!url) {
            return res.json({ error: 'URL is required' });
        }

        const websiteData = await extractWebsiteContent(url);
        
        if (!websiteData.success) {
            return res.json(websiteData);
        }

        const report = await generateBusinessReport(websiteData, model);
        res.json(report);

    } catch (error) {
        res.json({
            success: false,
            error: 'Report generation failed: ' + error.message
        });
    }
});

// Image generation endpoint
app.post('/api/generate-image', async (req, res) => {
    try {
        const { prompt } = req.body;
        
        if (!prompt) {
            return res.json({ error: 'Prompt is required' });
        }

        const imageResult = await generateImage(prompt);
        res.json(imageResult);

    } catch (error) {
        res.json({
            success: false,
            error: 'Image generation failed: ' + error.message
        });
    }
});

// Enhance prompt endpoint
app.post('/api/enhance-prompt', async (req, res) => {
    try {
        const { prompt } = req.body;
        
        if (!prompt) {
            return res.json({ error: 'Prompt is required' });
        }

        const enhancedPrompt = await enhanceImagePrompt(prompt);
        res.json({
            success: true,
            enhancedPrompt: enhancedPrompt
        });

    } catch (error) {
        res.json({
            success: false,
            error: 'Prompt enhancement failed: ' + error.message
        });
    }
});

app.get('/api/models', (req, res) => {
    res.json({ models: availableModels });
});

app.get('/health', async (req, res) => {
    const imageServices = {
        huggingface: !!HUGGINGFACE_API_KEY,
        stability: !!STABILITY_API_KEY,
        replicate: !!REPLICATE_API_KEY,
        openrouter: !!OPENROUTER_API_KEY
    };

    res.json({ 
        status: 'OK', 
        baseURL: OPENROUTER_BASE_URL,
        models: availableModels.length,
        default_model: defaultModel,
        image_services: imageServices,
        features: ['chat', 'website_extraction', 'business_reports', 'real_image_generation']
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

    socket.on('generate_image', async (data) => {
        try {
            const { prompt } = data;
            socket.emit('image_generation_start');
            
            const response = await axios.post('http://localhost:' + PORT + '/api/generate-image', { 
                prompt
            });
            socket.emit('image_result', response.data);
        } catch (error) {
            socket.emit('error', 'Image generation failed');
        }
    });

    socket.on('enhance_prompt', async (data) => {
        try {
            const { prompt } = data;
            
            const response = await axios.post('http://localhost:' + PORT + '/api/enhance-prompt', { 
                prompt
            });
            socket.emit('prompt_enhanced', response.data);
        } catch (error) {
            socket.emit('error', 'Prompt enhancement failed');
        }
    });

    socket.on('get_models', () => {
        socket.emit('models_list', { models: availableModels });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// Serve enhanced frontend (HTML remains largely the same but with better image handling)
app.get('/', (req, res) => {
    let modelsOptions = '';
    availableModels.forEach(model => {
        const selected = model.id === defaultModel ? ' selected' : '';
        modelsOptions += '<option value="' + model.id + '"' + selected + '>' + model.name + '</option>';
    });

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>AI Business Assistant</title>
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
            background: #ecf0f1; padding: 15px; border-radius: 10px;
            margin-bottom: 15px;
        }
        input, select, textarea, button {
            padding: 10px; margin: 5px; border: 1px solid #ddd;
            border-radius: 5px; font-size: 14px;
        }
        button {
            background: #3498db; color: white; cursor: pointer;
            border: none; transition: background 0.3s;
        }
        button:hover { background: #2980b9; }
        button:disabled { background: #7f8c8d; cursor: not-allowed; }
        .chat-area, .report-area, .image-area {
            flex: 1; background: white; border: 1px solid #ddd;
            border-radius: 10px; padding: 15px; overflow-y: auto;
            margin-bottom: 15px;
        }
        .message {
            margin: 10px 0; padding: 12px; border-radius: 10px;
            max-width: 80%;
        }
        .user-message {
            background: #007bff; color: white; margin-left: auto;
        }
        .ai-message {
            background: #e8f4f8; border: 1px solid #b3e0f2;
        }
        .report-content {
            white-space: pre-wrap; line-height: 1.6;
            background: #f8f9fa; padding: 15px; border-radius: 5px;
        }
        .image-result {
            max-width: 100%; border-radius: 10px; margin: 10px 0;
            border: 2px solid #3498db;
        }
        .provider-badge {
            background: #9b59b6; color: white; padding: 2px 8px;
            border-radius: 10px; font-size: 0.8em; margin-left: 5px;
        }
        .typing, .loading {
            color: #666; font-style: italic; padding: 10px;
            display: none;
        }
        .model-badge {
            background: #3498db; color: white; padding: 2px 8px;
            border-radius: 10px; font-size: 0.8em; margin-left: 5px;
        }
        .error-message {
            background: #ffebee; color: #c62828; border-color: #f44336;
        }
        .success-message {
            background: #e8f5e8; color: #2e7d32; border-color: #4caf50;
        }
        .enhanced-prompt {
            background: #fff3cd; border: 1px solid #ffeaa7;
            padding: 10px; border-radius: 5px; margin: 10px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🤖 AI Business Assistant</h1>
            <p>Chat • Website Analysis • Real Image Generation</p>
        </header>
        
        <div class="tabs">
            <button class="tab active" onclick="switchTab('chat')">💬 Chat</button>
            <button class="tab" onclick="switchTab('analysis')">📊 Business Analysis</button>
            <button class="tab" onclick="switchTab('images')">🎨 AI Images</button>
        </div>

        <!-- Chat Tab -->
        <div id="chat-tab" class="tab-content active">
            <div class="controls">
                <select id="modelSelect">` + modelsOptions + `</select>
                <button onclick="clearChat()">Clear Chat</button>
            </div>
            <div class="chat-area" id="chatArea">
                <div class="message ai-message">
                    Welcome! I can help you with chat conversations, business analysis, and REAL AI image generation.
                </div>
            </div>
            <div class="typing" id="typingIndicator">AI is typing...</div>
            <div style="display: flex;">
                <input type="text" id="messageInput" placeholder="Type your message..." style="flex: 1;" onkeypress="handleKeyPress(event)">
                <button onclick="sendMessage()">Send</button>
            </div>
        </div>

        <!-- Business Analysis Tab -->
        <div id="analysis-tab" class="tab-content">
            <div class="controls">
                <input type="url" id="websiteUrl" placeholder="Enter website URL (e.g., https://example.com)" style="flex: 1;">
                <select id="reportModel">` + modelsOptions + `</select>
                <button onclick="analyzeWebsite()">Analyze Website</button>
                <button onclick="generateBusinessReport()">Generate Full Report</button>
            </div>
            <div class="report-area" id="reportArea">
                <div class="message ai-message">
                    Enter a website URL to analyze and generate business reports.
                </div>
            </div>
            <div class="loading" id="analysisLoading">Analyzing website...</div>
        </div>

        <!-- Image Generation Tab -->
        <div id="images-tab" class="tab-content">
            <div class="controls">
                <textarea id="imagePrompt" placeholder="Describe the image you want to generate..." style="flex: 1; height: 80px;"></textarea>
                <button onclick="generateImage()">Generate Image</button>
                <button onclick="enhancePrompt()">Enhance Prompt</button>
            </div>
            <div class="image-area" id="imageArea">
                <div class="message ai-message">
                    Describe an image and I'll generate it using AI! Try: "a flying dog with wings in the sky"
                </div>
            </div>
            <div class="loading" id="imageLoading">Generating image... This may take 20-30 seconds.</div>
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
            const area = document.getElementById('reportArea');
            if (data.success) {
                addMessage('Website extracted successfully: ' + data.title, 'ai', null, 'reportArea');
                addMessage('Content preview: ' + data.content.substring(0, 200) + '...', 'ai', null, 'reportArea');
            } else {
                addMessage('Extraction failed: ' + data.error, 'error', null, 'reportArea');
            }
            document.getElementById('analysisLoading').style.display = 'none';
        });

        socket.on('report_result', (data) => {
            const area = document.getElementById('reportArea');
            if (data.success) {
                addMessage('Business Report Generated:', 'ai', null, 'reportArea');
                addMessage('<div class="report-content">' + data.report + '</div>', 'ai', null, 'reportArea');
            } else {
                addMessage('Report generation failed: ' + data.error, 'error', null, 'reportArea');
            }
            document.getElementById('analysisLoading').style.display = 'none';
        });

        socket.on('image_result', (data) => {
            const area = document.getElementById('imageArea');
            if (data.success) {
                addMessage('Image generated successfully! <span class="provider-badge">' + data.provider + '</span>', 'ai', null, 'imageArea');
                addMessage('<img src="' + data.imageUrl + '" class="image-result" alt="Generated image">', 'ai', null, 'imageArea');
                addMessage('Prompt: ' + data.prompt, 'ai', null, 'imageArea');
            } else if (data.fallback) {
                addMessage('Image generation unavailable', 'error', null, 'imageArea');
                addMessage('Enhanced prompt for manual use:', 'ai', null, 'imageArea');
                addMessage('<div class="enhanced-prompt">' + data.enhancedPrompt + '</div>', 'ai', null, 'imageArea');
            } else {
                addMessage('Image generation failed: ' + data.error, 'error', null, 'imageArea');
            }
            document.getElementById('imageLoading').style.display = 'none';
        });

        socket.on('prompt_enhanced', (data) => {
            if (data.success) {
                document.getElementById('imagePrompt').value = data.enhancedPrompt;
                addMessage('Prompt enhanced! Ready to generate.', 'ai', null, 'imageArea');
            } else {
                addMessage('Prompt enhancement failed: ' + data.error, 'error', null, 'imageArea');
            }
        });

        socket.on('error', (error) => {
            addMessage('Error: ' + error, 'error', null, 'chatArea');
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
            if (!url) return alert('Please enter a website URL');

            document.getElementById('analysisLoading').style.display = 'block';
            socket.emit('extract_website', { url: url });
        }

        function generateBusinessReport() {
            const url = document.getElementById('websiteUrl').value.trim();
            const model = document.getElementById('reportModel').value;
            
            if (!url) return alert('Please enter a website URL');

            document.getElementById('analysisLoading').style.display = 'block';
            socket.emit('generate_report', { 
                url: url, 
                model: model 
            });
        }

        // Image functions
        function generateImage() {
            const prompt = document.getElementById('imagePrompt').value.trim();
            if (!prompt) return alert('Please enter an image description');

            document.getElementById('imageLoading').style.display = 'block';
            socket.emit('generate_image', { prompt: prompt });
        }

        function enhancePrompt() {
            const prompt = document.getElementById('imagePrompt').value.trim();
            if (!prompt) return alert('Please enter a prompt to enhance');

            socket.emit('enhance_prompt', { prompt: prompt });
        }

        // Utility functions
        function addMessage(text, sender, model, areaId) {
            const area = document.getElementById(areaId);
            const messageDiv = document.createElement('div');
            
            let className = 'message ';
            if (sender === 'error') {
                className += 'error-message';
            } else if (sender === 'user') {
                className += 'user-message';
            } else {
                className += 'ai-message';
            }
            
            messageDiv.className = className;
            
            let content = text;
            if (model && sender === 'ai') {
                content += '<span class="model-badge">' + getModelName(model) + '</span>';
            }
            
            messageDiv.innerHTML = content;
            area.appendChild(messageDiv);
            area.scrollTop = area.scrollHeight;
        }

        function getModelName(modelId) {
            const parts = modelId.split('/');
            const name = parts[parts.length - 1].split(':')[0];
            return name.charAt(0).toUpperCase() + name.slice(1);
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
        console.log('🚀 AI Business Assistant with REAL Image Generation');
        console.log('==================================================');
        console.log('📍 Local: http://localhost:' + PORT);
        console.log('🔗 Base URL:', OPENROUTER_BASE_URL);
        console.log('🤖 Available models:', availableModels.length);
        console.log('🎨 Image Generation Services:');
        console.log('   - Hugging Face Stable Diffusion:', HUGGINGFACE_API_KEY ? '✅ Configured' : '❌ Not configured');
        console.log('   - Stability AI:', STABILITY_API_KEY ? '✅ Configured' : '❌ Not configured');
        console.log('   - Replicate:', REPLICATE_API_KEY ? '✅ Configured' : '❌ Not configured');
        console.log('   - OpenRouter:', OPENROUTER_API_KEY ? '✅ Configured' : '❌ Not configured');
        console.log('\n💡 Tip: Configure image API keys in .env for best results');
    });
});