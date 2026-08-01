require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');

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
            { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B' }
        ];
        defaultModel = availableModels[0].id;
    }
}

const conversations = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CONTACT EXTRACTION FUNCTIONS
function extractPhoneNumbers(html) {
    try {
        const cleanHtml = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                             .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
        
        const phonePatterns = [
            /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
            /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g,
            /tel:([^"'\s>]+)/gi,
            /href="tel:([^"]+)"/gi
        ];
        
        const foundNumbers = new Set();
        
        phonePatterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(cleanHtml)) !== null) {
                let phoneNumber = match[1] || match[0];
                phoneNumber = phoneNumber
                    .replace(/<[^>]*>/g, '')
                    .replace(/^tel:/, '')
                    .trim();
                
                if ((phoneNumber.match(/\d/g) || []).length >= 7) {
                    foundNumbers.add(phoneNumber);
                }
            }
        });
        
        return Array.from(foundNumbers).slice(0, 5);
    } catch (error) {
        return [];
    }
}

function extractEmails(html) {
    try {
        const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const emails = html.match(emailPattern) || [];
        return [...new Set(emails)].slice(0, 5);
    } catch (error) {
        return [];
    }
}

function extractAddresses(html) {
    try {
        const addressPatterns = [
            /(\d+\s+[\w\s]+,?\s*(?:\w+\s*)+,?\s*(?:\w+\s*){2,}\s*\d{5,6})/gi,
            /<address[^>]*>([\s\S]*?)<\/address>/gi,
            /Address[^:]*:?\s*([^<>\n]{10,100})/gi
        ];
        
        const foundAddresses = new Set();
        
        addressPatterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(html)) !== null) {
                let address = match[1] || match[0];
                address = address.replace(/<[^>]*>/g, '').trim();
                
                if (address.length > 10) {
                    foundAddresses.add(address);
                }
            }
        });
        
        return Array.from(foundAddresses).slice(0, 3);
    } catch (error) {
        return [];
    }
}

// WEBSITE EXTRACTION FUNCTION
async function extractWebsiteContent(url) {
    try {
        console.log('Extracting content from:', url);
        
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }

        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        const html = response.data;
        
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : 'No title found';
        
        const descMatch = html.match(/<meta name="description" content="([^"]*)"/i);
        const description = descMatch ? descMatch[1].trim() : 'No description found';
        
        const phoneNumbers = extractPhoneNumbers(html);
        const emails = extractEmails(html);
        const addresses = extractAddresses(html);
        
        let text = html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 1500);
        
        return {
            success: true,
            title: title,
            description: description,
            content: text,
            phoneNumbers: phoneNumbers,
            emails: emails,
            addresses: addresses,
            url: url
        };
        
    } catch (error) {
        console.error('Website extraction error:', error.message);
        return {
            success: false,
            error: 'Failed to extract website: ' + error.message,
            title: "Extraction Failed",
            description: "Could not retrieve website content",
            phoneNumbers: [],
            emails: [],
            addresses: [],
            url: url
        };
    }
}

// WEB SEARCH FUNCTIONALITY
async function performWebSearch(query, numResults = 5) {
    try {
        console.log('🔍 Performing web search for:', query);
        
        // Method 1: Using SerpAPI (if API key is available)
        if (SERPAPI_KEY) {
            const response = await axios.get('https://serpapi.com/search', {
                params: {
                    q: query,
                    api_key: SERPAPI_KEY,
                    engine: 'google',
                    num: numResults
                },
                timeout: 15000
            });
            
            if (response.data && response.data.organic_results) {
                return {
                    success: true,
                    results: response.data.organic_results.slice(0, numResults).map(result => ({
                        title: result.title,
                        url: result.link,
                        snippet: result.snippet
                    })),
                    source: 'serpapi'
                };
            }
        }
        
        // Method 2: Fallback - Use OpenRouter to generate search results
        console.log('Using AI-powered search fallback...');
        const searchPrompt = `Based on the search query "${query}", provide ${numResults} relevant website URLs that would be good for business analysis. For each, provide:
        - Website URL
        - Brief description of what the business does
        - Why it would be interesting to analyze
        
        Format as a clear list.`;
        
        const searchResponse = await axios.post(
            OPENROUTER_BASE_URL + '/chat/completions',
            {
                model: defaultModel,
                messages: [
                    { 
                        role: "system", 
                        content: "You are a research assistant that provides relevant business websites for analysis based on search queries." 
                    },
                    { role: "user", content: searchPrompt }
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
            results: [{ title: "AI-Generated Search Results", url: "", snippet: searchResponse.data.choices[0].message.content }],
            source: 'ai_fallback',
            rawResponse: searchResponse.data.choices[0].message.content
        };
        
    } catch (error) {
        console.error('Web search error:', error.message);
        return {
            success: false,
            error: 'Search failed: ' + error.message,
            results: []
        };
    }
}

// SEARCH AND ANALYZE FUNCTION
async function searchAndAnalyze(searchQuery, model = defaultModel) {
    try {
        console.log('Starting search and analysis for:', searchQuery);
        
        // Step 1: Perform web search
        const searchResults = await performWebSearch(searchQuery, 3);
        
        if (!searchResults.success) {
            return {
                success: false,
                error: 'Search failed: ' + searchResults.error
            };
        }

        let analysisResults = [];
        
        // Step 2: Analyze each search result
        for (const result of searchResults.results) {
            if (result.url && result.url.startsWith('http')) {
                try {
                    const websiteData = await extractWebsiteContent(result.url);
                    const analysis = await generateQuickAnalysis(websiteData, model);
                    
                    analysisResults.push({
                        searchResult: result,
                        websiteData: websiteData,
                        analysis: analysis
                    });
                } catch (error) {
                    console.error(`Analysis failed for ${result.url}:`, error.message);
                    analysisResults.push({
                        searchResult: result,
                        error: 'Analysis failed: ' + error.message
                    });
                }
            } else if (searchResults.source === 'ai_fallback') {
                // For AI-generated results, analyze the content directly
                const analysis = await generateQuickAnalysis({
                    success: true,
                    title: result.title,
                    description: "AI-generated search result",
                    content: result.snippet,
                    phoneNumbers: [],
                    emails: [],
                    addresses: [],
                    url: searchQuery
                }, model);
                
                analysisResults.push({
                    searchResult: result,
                    analysis: analysis,
                    isAIGenerated: true
                });
            }
        }

        return {
            success: true,
            searchQuery: searchQuery,
            searchResults: searchResults,
            analysisResults: analysisResults,
            model: model
        };

    } catch (error) {
        console.error('Search and analyze error:', error.message);
        return {
            success: false,
            error: 'Search and analysis failed: ' + error.message
        };
    }
}

// BUSINESS ANALYSIS FUNCTIONS
async function generateQuickAnalysis(websiteData, model = defaultModel) {
    try {
        const prompt = `Provide a quick business analysis based on this website information:

Website: ${websiteData.url}
Title: ${websiteData.title}
Description: ${websiteData.description}
Contact Information:
- Phone: ${websiteData.phoneNumbers?.join(', ') || 'Not found'}
- Email: ${websiteData.emails?.join(', ') || 'Not found'}
- Address: ${websiteData.addresses?.join(', ') || 'Not found'}
Content Sample: ${websiteData.content}

Provide a brief 3-paragraph analysis covering:
1. What type of business this appears to be and contact availability
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
Contact Information:
- Phone Numbers: ${websiteData.phoneNumbers?.join(', ') || 'Not found'}
- Email Addresses: ${websiteData.emails?.join(', ') || 'Not found'}
- Addresses: ${websiteData.addresses?.join(', ') || 'Not found'}
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

// ========== HTTP GET ROUTES ==========
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
        .chat-area, .analysis-area, .search-area {
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
        .contact-info {
            background: #e3f2fd; border: 1px solid #bbdefb; 
            padding: 12px; border-radius: 8px; margin: 8px 0;
        }
        .search-result {
            background: #f8f9fa; border: 1px solid #e1e8ed;
            padding: 15px; margin: 10px 0; border-radius: 8px;
        }
        .search-query {
            background: #e3f2fd; padding: 10px; border-radius: 5px;
            margin: 10px 0; font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🤖 AI Business Analysis App</h1>
            <p>AI Chat + Business Analysis + Web Search - Fully Functional</p>
        </header>
        
        <div class="tabs">
            <button class="tab active" onclick="switchTab('chat')">💬 AI Chat</button>
            <button class="tab" onclick="switchTab('analysis')">📊 Business Analysis</button>
            <button class="tab" onclick="switchTab('search')">🔍 Web Search</button>
        </div>

        <!-- Chat Tab -->
        <div id="chat-tab" class="tab-content active">
            <div class="controls">
                <select id="modelSelect">` + modelsOptions + `</select>
                <button onclick="clearChat()">Clear Chat</button>
            </div>
            <div class="chat-area" id="chatArea">
                <div class="message ai-message">
                    <strong>Welcome to AI Business Analysis App!</strong><br><br>
                    I can help you with AI chat, business analysis, and web search.
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
                    Enter any website to analyze its business potential and extract contact information.
                </div>
            </div>
            <div class="loading" id="analysisLoading">Processing... Please wait</div>
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
                </div>
            </div>
            <div class="search-area" id="searchArea">
                <div class="message ai-message">
                    <strong>Web Search & Analysis</strong><br><br>
                    Search the web and automatically analyze business websites.
                </div>
            </div>
            <div class="loading" id="searchLoading">Searching... Please wait</div>
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
            hideLoading('analysis');
            const area = document.getElementById('analysisArea');
            if (data.success) {
                addMessage('✅ Website information extracted:', 'ai', null, 'analysisArea');
                addMessage('<strong>Title:</strong> ' + data.title, 'ai', null, 'analysisArea');
                addMessage('<strong>Description:</strong> ' + data.description, 'ai', null, 'analysisArea');
                
                if (data.phoneNumbers && data.phoneNumbers.length > 0) {
                    addMessage('<div class="contact-info"><strong>📞 Phone Numbers:</strong><br>' + 
                        data.phoneNumbers.map(num => '• ' + num).join('<br>') + '</div>', 'ai', null, 'analysisArea');
                }
                
                if (data.emails && data.emails.length > 0) {
                    addMessage('<div class="contact-info"><strong>📧 Email Addresses:</strong><br>' + 
                        data.emails.map(email => '• ' + email).join('<br>') + '</div>', 'ai', null, 'analysisArea');
                }
                
                if (data.addresses && data.addresses.length > 0) {
                    addMessage('<div class="contact-info"><strong>📍 Addresses:</strong><br>' + 
                        data.addresses.map(addr => '• ' + addr).join('<br>') + '</div>', 'ai', null, 'analysisArea');
                }
            } else {
                addMessage('❌ Extraction failed: ' + data.error, 'error', null, 'analysisArea');
            }
        });

        socket.on('analysis_result', (data) => {
            hideLoading('analysis');
            const area = document.getElementById('analysisArea');
            if (data.success) {
                addMessage('⚡ Quick Analysis Complete:', 'success', null, 'analysisArea');
                addMessage('<div class="report-content">' + data.analysis + '</div>', 'ai', null, 'analysisArea');
            } else {
                addMessage('❌ Analysis failed: ' + data.error, 'error', null, 'analysisArea');
            }
        });

        socket.on('report_result', (data) => {
            hideLoading('analysis');
            const area = document.getElementById('analysisArea');
            if (data.success) {
                addMessage('📊 Business Report Generated:', 'success', null, 'analysisArea');
                addMessage('<div class="report-content">' + data.report + '</div>', 'ai', null, 'analysisArea');
            } else {
                addMessage('❌ Report failed: ' + data.error, 'error', null, 'analysisArea');
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
                        resultHtml += '<strong><a href="' + result.searchResult.url + '" target="_blank">' + (result.searchResult.title || result.searchResult.url) + '</a></strong><br>';
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

        socket.on('error', (error) => {
            hideLoading('analysis');
            hideLoading('search');
            addMessage('❌ Error: ' + error, 'error', null, 'analysisArea');
            addMessage('❌ Error: ' + error, 'error', null, 'searchArea');
        });

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
            if (!url) return alert('Please enter a website');

            showLoading('analysis');
            socket.emit('extract_website', { url: url });
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

// ========== HTTP POST ROUTES ==========
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

app.post('/api/search', async (req, res) => {
    try {
        const { query, model = defaultModel } = req.body;
        
        if (!query) {
            return res.json({ error: 'Search query is required' });
        }

        const searchResults = await performWebSearch(query);
        res.json(searchResults);

    } catch (error) {
        res.json({
            success: false,
            error: 'Search failed: ' + error.message
        });
    }
});

app.post('/api/search-and-analyze', async (req, res) => {
    try {
        const { query, model = defaultModel } = req.body;
        
        if (!query) {
            return res.json({ error: 'Search query is required' });
        }

        const results = await searchAndAnalyze(query, model);
        res.json(results);

    } catch (error) {
        res.json({
            success: false,
            error: 'Search and analyze failed: ' + error.message
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
        features: ['chat', 'website_analysis', 'business_reports', 'web_search', 'search_and_analyze']
    });
});

// ========== SOCKET.IO HANDLERS ==========
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('send_message', async (data) => {
        try {
            const { message, model, sessionId } = data;
            
            socket.emit('typing', true);

            const response = await axios.post(`http://localhost:${PORT}/api/chat`, {
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
            console.error('Socket chat error:', error.message);
            socket.emit('error', 'Failed to process message: ' + error.message);
        } finally {
            socket.emit('typing', false);
        }
    });

    socket.on('extract_website', async (data) => {
        try {
            const { url } = data;
            socket.emit('extraction_start');
            
            const websiteData = await extractWebsiteContent(url);
            socket.emit('extraction_result', websiteData);
        } catch (error) {
            console.error('Socket extraction error:', error.message);
            socket.emit('error', 'Website extraction failed: ' + error.message);
        }
    });

    socket.on('quick_analysis', async (data) => {
        try {
            const { url, model } = data;
            socket.emit('analysis_start');
            
            const websiteData = await extractWebsiteContent(url);
            const analysis = await generateQuickAnalysis(websiteData, model || defaultModel);
            socket.emit('analysis_result', analysis);
        } catch (error) {
            console.error('Socket analysis error:', error.message);
            socket.emit('error', 'Quick analysis failed: ' + error.message);
        }
    });

    socket.on('generate_report', async (data) => {
        try {
            const { url, model } = data;
            socket.emit('report_generation_start');
            
            const websiteData = await extractWebsiteContent(url);
            const report = await generateBusinessReport(websiteData, model || defaultModel);
            socket.emit('report_result', report);
        } catch (error) {
            console.error('Socket report error:', error.message);
            socket.emit('error', 'Report generation failed: ' + error.message);
        }
    });

    socket.on('perform_search', async (data) => {
        try {
            const { query, model } = data;
            socket.emit('search_start');
            
            const searchResults = await performWebSearch(query);
            socket.emit('search_results', searchResults);
        } catch (error) {
            console.error('Socket search error:', error.message);
            socket.emit('error', 'Search failed: ' + error.message);
        }
    });

    socket.on('search_and_analyze', async (data) => {
        try {
            const { query, model } = data;
            socket.emit('search_analysis_start');
            
            const results = await searchAndAnalyze(query, model || defaultModel);
            socket.emit('search_analysis_results', results);
        } catch (error) {
            console.error('Socket search analysis error:', error.message);
            socket.emit('error', 'Search and analysis failed: ' + error.message);
        }
    });

    socket.on('get_models', () => {
        socket.emit('models_list', { models: availableModels });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// ========== START SERVER ==========
fetchModels().then(() => {
    server.listen(PORT, () => {
        console.log('🚀 AI Business Analysis App Started!');
        console.log('📍 http://localhost:' + PORT);
        console.log('📊 Features: AI Chat, Business Analysis, Web Search');
        console.log('🔍 Contact extraction: Phone, Email, Address');
        console.log('🤖 Available models:', availableModels.length);
        
        if (!SERPAPI_KEY) {
            console.log('💡 Tip: Add SERPAPI_KEY to .env for enhanced web search');
        }
    });
});