const axios = require('axios');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
require('dotenv').config();

const execAsync = promisify(exec);

// ==================== ENHANCED SUPER APP GENERATOR WITH AI CHAT ====================
class SuperAppGenerator {
    constructor() {
        this.apiKey = process.env.GOOGLE_API_KEY;
        this.cseId = process.env.GOOGLE_CSE_ID;
        this.bingKey = process.env.BING_API_KEY;
        this.openRouterKey = process.env.OPENROUTER_API_KEY;
        this.baseURL = 'https://www.googleapis.com/customsearch/v1';
        this.openRouterURL = 'https://openrouter.ai/api/v1';
        
        // Create output directories
        this.outputDir = path.join(process.cwd(), 'output');
        this.tempDir = path.join(process.cwd(), 'temp');
        this.codeProjectsDir = path.join(process.cwd(), 'code-projects');
        this.ensureDirectories();
        
        // AI Models
        this.availableModels = [
            { id: 'google/gemini-2.0-flash-exp:free', name: 'Google Gemini 2.0 Flash' },
            { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B' },
            { id: 'anthropic/claude-3.5-sonnet:free', name: 'Claude 3.5 Sonnet' },
            { id: 'openai/gpt-3.5-turbo', name: 'GPT-3.5 Turbo' }
        ];
        this.defaultModel = this.availableModels[0].id;
        this.conversations = new Map();
        
        // Validate API credentials
        this.validateAPICredentials();
        
        // Create readline interface for user input
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        this.searchSessions = [];
        this.currentSession = null;
        this.searchCount = 0;
    }

    ensureDirectories() {
        [this.outputDir, this.tempDir, this.codeProjectsDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    validateAPICredentials() {
        console.log(chalk.blue.bold('\n🔧 API CONFIGURATION STATUS'));
        console.log(chalk.gray('='.repeat(50)));
        
        const engines = {
            'Google Search': !!this.apiKey && !!this.cseId,
            'Bing Search': !!this.bingKey,
            'OpenRouter AI': !!this.openRouterKey,
            'Yahoo Search': true,
            'Ask.com': true,
            'AOL Search': true
        };

        Object.entries(engines).forEach(([engine, available]) => {
            const status = available ? chalk.green('✅ Available') : chalk.yellow('⚠️  API Key Required');
            console.log(chalk.white(`   ${engine}: ${status}`));
        });

        if (!this.openRouterKey) {
            console.log(chalk.yellow('\n💡 OpenRouter AI Setup (REQUIRED for AI Chat):'));
            console.log(chalk.white('   1. Visit: https://openrouter.ai/'));
            console.log(chalk.white('   2. Sign up for free account'));
            console.log(chalk.white('   3. Get API key from https://openrouter.ai/keys'));
            console.log(chalk.white('   4. Add to .env:'));
            console.log(chalk.cyan('      OPENROUTER_API_KEY=your_key_here'));
        }

        if (!this.apiKey) {
            console.log(chalk.yellow('\n💡 Google Search Setup:'));
            console.log(chalk.white('   1. Visit: https://console.developers.google.com/'));
            console.log(chalk.white('   2. Enable Custom Search API'));
            console.log(chalk.white('   3. Create Custom Search Engine'));
            console.log(chalk.white('   4. Add to .env:'));
            console.log(chalk.cyan('      GOOGLE_API_KEY=your_key_here'));
            console.log(chalk.cyan('      GOOGLE_CSE_ID=your_cse_id_here'));
        }

        console.log(chalk.gray('─'.repeat(50)));
    }

    // ==================== NEW: AI CHAT MODE ====================
    async startAIChatMode() {
        console.log(chalk.yellow.bold('\n🤖 AI CHAT MODE'));
        console.log(chalk.gray('='.repeat(50)));
        console.log(chalk.cyan('   Chat with multiple AI models!'));
        console.log(chalk.gray('─'.repeat(50)));
        console.log(chalk.white('   Available AI Models:'));
        this.availableModels.forEach((model, index) => {
            console.log(chalk.yellow(`   ${index + 1}. ${model.name}`));
        });
        console.log(chalk.gray('─'.repeat(50)));

        if (!this.openRouterKey) {
            console.log(chalk.red('❌ OpenRouter API key required for AI Chat'));
            console.log(chalk.yellow('💡 Get free key from: https://openrouter.ai/'));
            this.returnToMainMenu();
            return;
        }

        this.rl.question(chalk.magenta('Select AI model (1-4): '), async (modelChoice) => {
            const modelIndex = parseInt(modelChoice) - 1;
            if (modelIndex < 0 || modelIndex >= this.availableModels.length) {
                console.log(chalk.red('❌ Please select a valid model (1-4)'));
                this.startAIChatMode();
                return;
            }

            const selectedModel = this.availableModels[modelIndex];
            console.log(chalk.green(`✅ Selected: ${selectedModel.name}`));
            
            await this.chatWithAI(selectedModel);
        });
    }

    async chatWithAI(selectedModel) {
        const sessionId = 'chat_' + Date.now();
        this.conversations.set(sessionId, []);

        console.log(chalk.blue.bold('\n💬 AI CHAT STARTED'));
        console.log(chalk.gray('Type "exit" to end chat, "clear" to clear history'));
        console.log(chalk.gray('─'.repeat(50)));

        const chatLoop = async () => {
            this.rl.question(chalk.magenta('You: '), async (message) => {
                if (message.toLowerCase() === 'exit') {
                    console.log(chalk.yellow('👋 Ending AI chat...'));
                    this.returnToMainMenu();
                    return;
                }

                if (message.toLowerCase() === 'clear') {
                    this.conversations.set(sessionId, []);
                    console.log(chalk.green('✅ Chat history cleared'));
                    return chatLoop();
                }

                if (!message.trim()) {
                    console.log(chalk.red('❌ Please enter a message'));
                    return chatLoop();
                }

                try {
                    console.log(chalk.blue('🤖 AI is thinking...'));
                    
                    const response = await this.getAIResponse(message, selectedModel.id, sessionId);
                    
                    // Apply different visual styles based on content
                    const styledResponse = this.styleAIResponse(response, message);
                    console.log(chalk.green.bold('\n🤖 AI:'));
                    console.log(styledResponse);
                    console.log(chalk.gray('─'.repeat(50)));

                } catch (error) {
                    console.log(chalk.red('❌ AI Error:'), error.message);
                }

                chatLoop();
            });
        };

        // Initial welcome message
        const welcomeResponse = await this.getAIResponse(
            "Introduce yourself briefly and mention your capabilities", 
            selectedModel.id, 
            sessionId
        );
        console.log(chalk.green.bold('\n🤖 AI:'));
        console.log(this.styleAIResponse(welcomeResponse, 'welcome'));
        console.log(chalk.gray('─'.repeat(50)));

        chatLoop();
    }

    async getAIResponse(message, model = this.defaultModel, sessionId = 'default') {
        if (!this.conversations.has(sessionId)) {
            this.conversations.set(sessionId, []);
        }
        const conversation = this.conversations.get(sessionId);

        const messages = [
            { 
                role: "system", 
                content: `You are a helpful AI assistant. Provide well-formatted, engaging responses. 
                Use appropriate formatting like sections, bullet points, and examples when helpful.
                Be creative and adapt your response style to match the user's query.` 
            },
            ...conversation.slice(-6), // Keep last 6 messages for context
            { role: "user", content: message }
        ];

        const response = await axios.post(
            this.openRouterURL + '/chat/completions',
            {
                model: model,
                messages: messages,
                max_tokens: 1500,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': 'Bearer ' + this.openRouterKey,
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

        if (conversation.length > 12) {
            conversation.splice(0, 2);
        }

        return aiMessage;
    }

    styleAIResponse(response, userMessage) {
        const lowerMessage = userMessage.toLowerCase();
        
        // Different styling based on message content
        if (lowerMessage.includes('code') || lowerMessage.includes('program') || lowerMessage.includes('function')) {
            return chalk.cyan(this.formatCodeResponse(response));
        } 
        else if (lowerMessage.includes('business') || lowerMessage.includes('analysis') || lowerMessage.includes('report')) {
            return chalk.green(this.formatBusinessResponse(response));
        }
        else if (lowerMessage.includes('creative') || lowerMessage.includes('story') || lowerMessage.includes('poem')) {
            return chalk.magenta(this.formatCreativeResponse(response));
        }
        else if (lowerMessage.includes('help') || lowerMessage.includes('how to') || lowerMessage.includes('tutorial')) {
            return chalk.yellow(this.formatHelpResponse(response));
        }
        else if (lowerMessage.includes('welcome') || lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
            return chalk.blue.bold(this.formatWelcomeResponse(response));
        }
        else {
            return chalk.white(this.formatGeneralResponse(response));
        }
    }

    formatCodeResponse(text) {
        return `
┌────────────────────────────────────────────────────────┐
│ 🚀 CODE RESPONSE                                       │
├────────────────────────────────────────────────────────┤
${text.split('\n').map(line => `│ ${line.padEnd(52)} │`).join('\n')}
└────────────────────────────────────────────────────────┘`;
    }

    formatBusinessResponse(text) {
        return `
╔════════════════════════════════════════════════════════╗
║ 📊 BUSINESS ANALYSIS                                   ║
╠════════════════════════════════════════════════════════╣
${text.split('\n').map(line => `║ ${line.padEnd(52)} ║`).join('\n')}
╚════════════════════════════════════════════════════════╝`;
    }

    formatCreativeResponse(text) {
        return `
✦✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧
   🎨 CREATIVE RESPONSE
✦✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧

${text}

✦✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧✧`;
    }

    formatHelpResponse(text) {
        return `
📚 HELP & GUIDANCE
──────────────────────────────────────────────────────────
${text}
──────────────────────────────────────────────────────────`;
    }

    formatWelcomeResponse(text) {
        return `
✨ WELCOME MESSAGE ✨
──────────────────────────────────────────────────────────
${text}
──────────────────────────────────────────────────────────`;
    }

    formatGeneralResponse(text) {
        return `
💬 GENERAL RESPONSE
──────────────────────────────────────────────────────────
${text}
──────────────────────────────────────────────────────────`;
    }

    // ==================== NEW: AI-POWERED BUSINESS ANALYSIS ====================
    async startBusinessAnalysisMode() {
        console.log(chalk.yellow.bold('\n📊 AI BUSINESS ANALYSIS MODE'));
        console.log(chalk.gray('='.repeat(50)));
        console.log(chalk.cyan('   Analyze businesses with AI intelligence!'));
        console.log(chalk.gray('─'.repeat(50)));
        console.log(chalk.white('   Options:'));
        console.log(chalk.yellow('   1. 🔍 Quick Business Analysis'));
        console.log(chalk.yellow('   2. 📈 Comprehensive Business Report'));
        console.log(chalk.yellow('   3. 💼 Competitor Analysis'));
        console.log(chalk.yellow('   4. 🎯 Market Research'));
        console.log(chalk.gray('─'.repeat(50)));

        this.rl.question(chalk.magenta('Select analysis type (1-4): '), async (choice) => {
            switch (choice.trim()) {
                case '1':
                    await this.quickBusinessAnalysis();
                    break;
                case '2':
                    await this.comprehensiveBusinessReport();
                    break;
                case '3':
                    await this.competitorAnalysis();
                    break;
                case '4':
                    await this.marketResearch();
                    break;
                default:
                    console.log(chalk.red('❌ Please select 1-4'));
                    this.startBusinessAnalysisMode();
                    break;
            }
        });
    }

    async quickBusinessAnalysis() {
        this.rl.question(chalk.magenta('Enter business/company name or website: '), async (business) => {
            if (!business.trim()) {
                console.log(chalk.red('❌ Please enter a business name'));
                this.quickBusinessAnalysis();
                return;
            }

            try {
                console.log(chalk.blue('🤖 Analyzing business with AI...'));
                
                const prompt = `Provide a quick business analysis for: ${business}
                
Please analyze:
1. Business type and industry
2. Target market and customers
3. Key strengths and opportunities
4. Potential challenges
5. Quick recommendations

Keep it concise but insightful.`;

                const analysis = await this.getAIResponse(prompt, this.defaultModel, 'business_analysis');
                console.log(chalk.green.bold('\n📊 QUICK BUSINESS ANALYSIS:'));
                console.log(this.formatBusinessResponse(analysis));
                
                this.continueBusinessAnalysis();

            } catch (error) {
                console.log(chalk.red('❌ Analysis failed:'), error.message);
                this.continueBusinessAnalysis();
            }
        });
    }

    async comprehensiveBusinessReport() {
        this.rl.question(chalk.magenta('Enter business/company for comprehensive report: '), async (business) => {
            if (!business.trim()) {
                console.log(chalk.red('❌ Please enter a business name'));
                this.comprehensiveBusinessReport();
                return;
            }

            try {
                console.log(chalk.blue('🤖 Generating comprehensive business report...'));
                
                const prompt = `Create a comprehensive business analysis report for: ${business}
                
STRUCTURE YOUR REPORT WITH THESE SECTIONS:

EXECUTIVE SUMMARY
- Business overview and key findings

MARKET ANALYSIS
- Industry overview and trends
- Target market segmentation
- Competitive landscape

OPERATIONAL ANALYSIS
- Business model and operations
- Key partnerships and resources

FINANCIAL CONSIDERATIONS
- Revenue streams and cost structure
- Investment requirements

STRATEGIC RECOMMENDATIONS
- Growth opportunities
- Risk mitigation strategies
- Actionable next steps

CONCLUSION
- Overall assessment and outlook

Make this a professional, detailed business report.`;

                const report = await this.getAIResponse(prompt, this.defaultModel, 'business_report');
                console.log(chalk.green.bold('\n📈 COMPREHENSIVE BUSINESS REPORT:'));
                console.log(this.formatBusinessResponse(report));
                
                // Save to file
                const filename = `business-report-${business.replace(/\s+/g, '-')}-${Date.now()}.txt`;
                const filepath = path.join(this.outputDir, filename);
                fs.writeFileSync(filepath, `COMPREHENSIVE BUSINESS REPORT\n${'='.repeat(50)}\n\n${report}`);
                console.log(chalk.cyan('💾 Report saved to: ' + filepath));
                
                this.continueBusinessAnalysis();

            } catch (error) {
                console.log(chalk.red('❌ Report generation failed:'), error.message);
                this.continueBusinessAnalysis();
            }
        });
    }

    async competitorAnalysis() {
        this.rl.question(chalk.magenta('Enter business for competitor analysis: '), async (business) => {
            if (!business.trim()) {
                console.log(chalk.red('❌ Please enter a business name'));
                this.competitorAnalysis();
                return;
            }

            try {
                console.log(chalk.blue('🤖 Analyzing competitors...'));
                
                const prompt = `Perform a competitor analysis for: ${business}
                
Please provide:
1. Main competitors in the space
2. Competitive advantages of each
3. Market positioning comparison
4. SWOT analysis (Strengths, Weaknesses, Opportunities, Threats)
5. Strategic recommendations for competitive advantage`;

                const analysis = await this.getAIResponse(prompt, this.defaultModel, 'competitor_analysis');
                console.log(chalk.green.bold('\n💼 COMPETITOR ANALYSIS:'));
                console.log(this.formatBusinessResponse(analysis));
                
                this.continueBusinessAnalysis();

            } catch (error) {
                console.log(chalk.red('❌ Competitor analysis failed:'), error.message);
                this.continueBusinessAnalysis();
            }
        });
    }

    async marketResearch() {
        this.rl.question(chalk.magenta('Enter industry/market for research: '), async (market) => {
            if (!market.trim()) {
                console.log(chalk.red('❌ Please enter an industry or market'));
                this.marketResearch();
                return;
            }

            try {
                console.log(chalk.blue('🤖 Conducting market research...'));
                
                const prompt = `Conduct comprehensive market research for: ${market}
                
Please provide:
1. Market size and growth trends
2. Key market drivers and challenges
3. Target customer demographics
4. Regulatory environment
5. Technology trends affecting the market
6. Investment and funding landscape
7. Future outlook and predictions`;

                const research = await this.getAIResponse(prompt, this.defaultModel, 'market_research');
                console.log(chalk.green.bold('\n🎯 MARKET RESEARCH REPORT:'));
                console.log(this.formatBusinessResponse(research));
                
                this.continueBusinessAnalysis();

            } catch (error) {
                console.log(chalk.red('❌ Market research failed:'), error.message);
                this.continueBusinessAnalysis();
            }
        });
    }

    continueBusinessAnalysis() {
        this.rl.question(chalk.cyan('\n📊 Perform another business analysis? (y/n): '), (answer) => {
            if (answer.toLowerCase() === 'y') {
                this.startBusinessAnalysisMode();
            } else {
                this.returnToMainMenu();
            }
        });
    }

    // ==================== ENHANCED MAIN MENU ====================
    async startMainApp() {
        console.log(chalk.yellow.bold('\n🚀 SUPER APPLICATION GENERATOR PRO'));
        console.log(chalk.gray('='.repeat(60)));
        console.log(chalk.cyan('   Choose your mode:'));
        console.log(chalk.white('   1. 🔍 Search Mode (Multi-Engine Search)'));
        console.log(chalk.white('   2. 💻 Code Execution Mode (Run JS/Python/Shell)'));
        console.log(chalk.white('   3. 🤖 AI Chat Mode (Talk to Multiple AI Models)'));
        console.log(chalk.white('   4. 📊 Business Analysis (AI-Powered Insights)'));
        console.log(chalk.white('   5. 🚀 Full Project Generation'));
        console.log(chalk.gray('─'.repeat(60)));
        console.log(chalk.white('   Type "back" in any mode to return to main menu'));
        console.log(chalk.gray('─'.repeat(60)));

        this.rl.question(chalk.magenta('Select mode (1-5): '), (choice) => {
            switch (choice.trim()) {
                case '1':
                    this.startUserInputSearch();
                    break;
                case '2':
                    this.startCodeExecutionMode();
                    break;
                case '3':
                    this.startAIChatMode();
                    break;
                case '4':
                    this.startBusinessAnalysisMode();
                    break;
                case '5':
                    this.startFullCodeGenerationMode();
                    break;
                default:
                    console.log(chalk.red('❌ Please select 1-5'));
                    this.startMainApp();
                    break;
            }
        });
    }

    // ==================== EXISTING SEARCH FUNCTIONALITY (UNCHANGED) ====================
    async startUserInputSearch() {
        // ... keep all your existing search code exactly as it was ...
        console.log(chalk.yellow.bold('\n🔍 MULTI-ENGINE SEARCH MODE'));
        console.log(chalk.gray('='.repeat(50)));
        console.log(chalk.cyan('   Search across multiple search engines!'));
        console.log(chalk.gray('─'.repeat(50)));

        this.rl.question(chalk.magenta('Enter your search query: '), async (query) => {
            if (!query.trim()) {
                console.log(chalk.red('Please enter a search query.'));
                this.returnToMainMenu();
                return;
            }

            try {
                console.log(chalk.blue('\n🔍 Searching across multiple engines: "' + query + '"...'));
                const allResults = await this.searchAllEngines(query);
                this.displayMultiEngineResults(allResults, query);
                
                const html = this.generateMultiEngineHTML(allResults, query);
                const filename = `multi-search-${Date.now()}.html`;
                const filepath = this.saveHTMLToFile(html, filename);
                
                console.log(chalk.green('📄 Comprehensive HTML report generated: ' + filepath));
                
                this.rl.question(chalk.cyan('\n🌐 Open in browser? (y/n): '), (answer) => {
                    if (answer.toLowerCase() === 'y') {
                        this.openInChrome(filepath);
                    }
                    this.continueSearching();
                });

            } catch (error) {
                console.log(chalk.red('❌ Multi-engine search failed:'), error.message);
                this.continueSearching();
            }
        });
    }

    // ... include all your existing search methods exactly as they were ...
    async searchAllEngines(query) {
        const searchPromises = [];
        
        if (this.apiKey && this.cseId) {
            searchPromises.push(this.googleSearch(query).catch(error => ({
                engine: 'Google',
                error: error.message,
                results: []
            })));
        }

        if (this.bingKey) {
            searchPromises.push(this.bingSearch(query).catch(error => ({
                engine: 'Bing',
                error: error.message,
                results: []
            })));
            searchPromises.push(this.yahooSearch(query).catch(error => ({
                engine: 'Yahoo',
                error: error.message,
                results: []
            })));
        }

        searchPromises.push(this.askSearch(query).catch(error => ({
            engine: 'Ask',
            error: error.message,
            results: []
        })));

        searchPromises.push(this.aolSearch(query).catch(error => ({
            engine: 'AOL',
            error: error.message,
            results: []
        })));

        const results = await Promise.allSettled(searchPromises);
        const engineResults = {};
        results.forEach(result => {
            if (result.status === 'fulfilled') {
                const data = result.value;
                engineResults[data.engine] = data;
            }
        });

        return engineResults;
    }

    async googleSearch(query) {
        // ... your existing googleSearch method ...
        console.log(chalk.gray('   🔍 Searching Google...'));
        try {
            const response = await axios.get(this.baseURL, {
                params: {
                    key: this.apiKey,
                    cx: this.cseId,
                    q: query,
                    num: 10,
                    start: 1
                },
                timeout: 10000
            });

            const data = response.data;
            const results = (data.items || []).map(item => ({
                title: item.title,
                link: item.link,
                snippet: item.snippet,
                displayLink: item.displayLink
            }));

            return {
                engine: 'Google',
                results: results,
                total: data.searchInformation?.totalResults || results.length,
                searchTime: data.searchInformation?.formattedSearchTime || '0.5',
                error: null
            };

        } catch (error) {
            throw new Error(this.getGoogleError(error));
        }
    }

    // ... include all your other existing methods exactly as they were ...
    // startCodeExecutionMode(), executeJavaScript(), executePython(), executeShell()
    // startAICodeGeneration(), generateCodeFromDescription()
    // startFullCodeGenerationMode(), generateDemoProject()
    // returnToMainMenu(), close()

    returnToMainMenu() {
        this.rl.question(chalk.cyan('\n🔙 Press Enter to return to main menu...'), () => {
            this.startMainApp();
        });
    }

    close() {
        if (this.rl) {
            this.rl.close();
        }
    }
}

// ==================== MAIN APPLICATION ====================
async function main() {
    const app = new SuperAppGenerator();
    
    try {
        await app.startMainApp();
    } catch (error) {
        console.error(chalk.red.bold('💥 Fatal error:'), error.message);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log(chalk.yellow('\n👋 Goodbye!'));
    process.exit(0);
});

if (require.main === module) {
    main().catch(error => {
        console.error(chalk.red.bold('💥 Unhandled error:'), error);
        process.exit(1);
    });
}

module.exports = SuperAppGenerator;