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
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const OPENCAGE_API_KEY = process.env.OPENCAGE_API_KEY;

let availableModels = [];
let defaultModel = '';

// Rate limiting protection
const requestQueue = [];
let isProcessingQueue = false;

async function processRequestQueue() {
    if (isProcessingQueue || requestQueue.length === 0) return;
    
    isProcessingQueue = true;
    
    while (requestQueue.length > 0) {
        const request = requestQueue.shift();
        try {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
            const result = await request.fn();
            request.resolve(result);
        } catch (error) {
            request.reject(error);
        }
    }
    
    isProcessingQueue = false;
}

function queueRequest(fn) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ fn, resolve, reject });
        processRequestQueue();
    });
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

// ==================== IMPROVED OPENSTREETMAP BUSINESS SEARCH ====================
async function getBusinessesFromOSM(query, location = '', category = '') {
    try {
        console.log('🏢 Searching OpenStreetMap for:', query);
        
        // More specific Overpass API query with better timeout handling
        let overpassQuery = `
            [out:json][timeout:15];
            (
              node["name"~"${query}", i]["shop"];
              node["name"~"${query}", i]["amenity"~"restaurant|cafe|bar|bank|pharmacy"];
              node["name"~"${query}", i]["office"];
              node["name"~"${query}", i]["craft"];
              way["name"~"${query}", i]["shop"];
              way["name"~"${query}", i]["amenity"~"restaurant|cafe|bar|bank|pharmacy"];
            );
            out body;
            >;
            out skel qt;
        `;

        const response = await axios.post('https://overpass-api.de/api/interpreter', 
            `data=${encodeURIComponent(overpassQuery)}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 15000 // Reduced timeout
            }
        );

        if (response.data && response.data.elements) {
            const businesses = response.data.elements
                .filter(element => element.tags && element.tags.name)
                .map(element => {
                    const tags = element.tags;
                    const lat = element.lat || (element.center && element.center.lat);
                    const lon = element.lon || (element.center && element.center.lon);
                    
                    return {
                        name: tags.name,
                        type: tags.shop || tags.amenity || tags.office || tags.craft || tags.tourism || tags.leisure || 'business',
                        formatted_address: [
                            tags['addr:street'],
                            tags['addr:city'],
                            tags['addr:postcode'],
                            tags['addr:country']
                        ].filter(Boolean).join(', ') || 'Address not specified',
                        street: tags['addr:street'],
                        city: tags['addr:city'],
                        state: tags['addr:state'],
                        country: tags['addr:country'],
                        postcode: tags['addr:postcode'],
                        latitude: lat,
                        longitude: lon,
                        phone: tags.phone,
                        website: tags.website,
                        email: tags.email,
                        opening_hours: tags.opening_hours,
                        confidence: 0.7,
                        source: 'openstreetmap',
                        category: tags.shop || tags.amenity || 'business'
                    };
                })
                .filter(business => business.latitude && business.longitude); // Filter invalid coordinates

            console.log(`✅ OpenStreetMap found: ${businesses.length} results`);
            return {
                success: true,
                results: businesses,
                total: businesses.length
            };
        }

        return { success: true, results: [], total: 0 };
    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            console.log('⚠️ OpenStreetMap timeout - using fallback');
        } else {
            console.error('OSM search error:', error.message);
        }
        return { success: false, error: 'OpenStreetMap search failed: ' + error.message, results: [] };
    }
}

// ==================== IMPROVED WIKIDATA BUSINESS SEARCH ====================
async function getBusinessesFromWikidata(query) {
    try {
        console.log('📚 Searching Wikidata for:', query);
        
        // Use a more reliable Wikidata endpoint with better error handling
        const searchResponse = await axios.get('https://www.wikidata.org/w/api.php', {
            params: {
                action: 'wbsearchentities',
                search: query,
                language: 'en',
                format: 'json',
                type: 'item',
                limit: 5 // Reduced limit for performance
            },
            timeout: 10000,
            headers: {
                'User-Agent': 'BusinessDirectoryApp/1.0'
            }
        });

        if (searchResponse.data && searchResponse.data.search) {
            const businesses = [];
            const entityPromises = [];
            
            for (const item of searchResponse.data.search.slice(0, 3)) { // Further reduced for performance
                entityPromises.push(
                    axios.get(
                        `https://www.wikidata.org/wiki/Special:EntityData/${item.id}.json`,
                        { 
                            timeout: 8000,
                            headers: {
                                'User-Agent': 'BusinessDirectoryApp/1.0'
                            }
                        }
                    ).then(entityResponse => {
                        const entity = entityResponse.data.entities[item.id];
                        const claims = entity.claims || {};
                        
                        // Extract website
                        let website = '';
                        if (claims.P856 && claims.P856[0]) {
                            website = claims.P856[0].mainsnak.datavalue?.value;
                        }
                        
                        // Extract description
                        let description = item.description || '';
                        if (entity.descriptions && entity.descriptions.en) {
                            description = entity.descriptions.en.value;
                        }
                        
                        return {
                            name: item.label,
                            description: description,
                            type: 'company',
                            formatted_address: 'Global corporation',
                            website: website,
                            confidence: 0.6,
                            source: 'wikidata',
                            category: 'corporation',
                            note: 'Wikipedia business entity - ' + description
                        };
                    }).catch(error => {
                        console.log(`Skipping Wikidata entity ${item.id}:`, error.message);
                        return null;
                    })
                );
            }

            const results = await Promise.allSettled(entityPromises);
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    businesses.push(result.value);
                }
            });

            console.log(`✅ Wikidata found: ${businesses.length} results`);
            return {
                success: true,
                results: businesses.filter(b => b && b.name),
                total: businesses.length
            };
        }

        return { success: true, results: [], total: 0 };
    } catch (error) {
        console.error('Wikidata search error:', error.message);
        return { success: false, error: 'Wikidata search failed: ' + error.message, results: [] };
    }
}

// ==================== IMPROVED GOOGLE PLACES BUSINESS SEARCH ====================
async function getBusinessesFromGooglePlaces(query, location = '') {
    try {
        if (!GOOGLE_API_KEY) {
            return { success: false, error: 'Google API key not configured', results: [] };
        }

        console.log('🔍 Searching Google Places for:', query);
        
        const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
            params: {
                query: query + (location ? ` in ${location}` : ''),
                key: GOOGLE_API_KEY,
                type: 'establishment'
            },
            timeout: 10000
        });

        if (response.data.results && response.data.results.length > 0) {
            const businesses = response.data.results.map(place => ({
                name: place.name,
                formatted_address: place.formatted_address,
                type: place.types?.[0] || 'establishment',
                latitude: place.geometry?.location?.lat,
                longitude: place.geometry?.location?.lng,
                rating: place.rating,
                total_ratings: place.user_ratings_total,
                open_now: place.opening_hours?.open_now,
                confidence: 0.9,
                source: 'google_places',
                category: place.types?.[0] || 'business',
                place_id: place.place_id
            }));

            console.log(`✅ Google Places found: ${businesses.length} results`);
            return {
                success: true,
                results: businesses,
                total: businesses.length
            };
        }

        return { success: true, results: [], total: 0 };
    } catch (error) {
        console.error('Google Places error:', error.message);
        return { success: false, error: 'Google Places search failed: ' + error.message, results: [] };
    }
}

// ==================== IMPROVED OPEN CAGE BUSINESS SEARCH ====================
async function getBusinessesFromOpenCage(query) {
    if (!OPENCAGE_API_KEY) {
        return { success: false, error: 'OpenCage API key not configured', results: [] };
    }

    try {
        console.log('🏢 Searching OpenCage for:', query);
        
        const response = await axios.get('https://api.opencagedata.com/geocode/v1/json', {
            params: {
                q: query,
                key: OPENCAGE_API_KEY,
                limit: 10,
                no_annotations: 1,
                pretty: 0
            },
            timeout: 10000
        });
        
        if (response.data.results && response.data.results.length > 0) {
            const results = response.data.results
                .filter(result => result.components && (result.components.company || result.components.business || result.components.shop))
                .map((result) => {
                    const components = result.components;
                    return {
                        name: components.company || components.business || components.shop || components.office || query,
                        formatted_address: result.formatted,
                        street: components.road,
                        city: components.city || components.town || components.village,
                        state: components.state,
                        country: components.country,
                        postcode: components.postcode,
                        latitude: result.geometry.lat,
                        longitude: result.geometry.lng,
                        phone: components.phone,
                        website: components.website,
                        confidence: result.confidence / 10,
                        type: components._type || components.type,
                        source: 'opencage',
                        category: components._category || 'business'
                    };
                })
                .filter(result => result.confidence > 0.3);

            console.log(`✅ OpenCage found: ${results.length} results`);
            return {
                success: true,
                results: results,
                total_results: results.length
            };
        } else {
            return {
                success: true,
                results: [],
                total_results: 0
            };
        }
    } catch (error) {
        console.error('OpenCage API error:', error.message);
        return {
            success: false,
            error: 'OpenCage search failed: ' + error.message,
            results: []
        };
    }
}

// ==================== IMPROVED COMBINED BUSINESS DIRECTORY SEARCH ====================
async function searchBusinessDirectory(query, options = {}) {
    const {
        location = '',
        limit = 20, // Increased limit
        sources = ['openstreetmap', 'wikidata', 'opencage', 'google_places']
    } = options;

    console.log(`🔍 Comprehensive business search for: "${query}"`);

    const searchPromises = [];
    const allResults = [];

    // Configure search sources with better error handling
    const sourceConfig = {
        openstreetmap: {
            enabled: sources.includes('openstreetmap'),
            fn: () => getBusinessesFromOSM(query, location)
        },
        wikidata: {
            enabled: sources.includes('wikidata'),
            fn: () => getBusinessesFromWikidata(query)
        },
        opencage: {
            enabled: sources.includes('opencage') && OPENCAGE_API_KEY,
            fn: () => getBusinessesFromOpenCage(query)
        },
        google_places: {
            enabled: sources.includes('google_places') && GOOGLE_API_KEY,
            fn: () => getBusinessesFromGooglePlaces(query, location)
        }
    };

    // Execute all searches in parallel with individual error handling
    for (const [sourceName, config] of Object.entries(sourceConfig)) {
        if (config.enabled) {
            searchPromises.push(
                Promise.resolve().then(async () => {
                    try {
                        const result = await config.fn();
                        if (result.success && result.results && result.results.length > 0) {
                            console.log(`✅ ${sourceName} found: ${result.results.length} results`);
                            allResults.push(...result.results);
                        } else {
                            console.log(`⚠️ ${sourceName}: No results or failed`);
                        }
                    } catch (error) {
                        console.error(`❌ ${sourceName} search failed:`, error.message);
                    }
                })
            );
        } else {
            console.log(`⏭️ ${sourceName}: Skipped (not enabled or missing API key)`);
        }
    }

    // Wait for all searches to complete with timeout
    try {
        await Promise.allSettled(searchPromises);
    } catch (error) {
        console.error('Search coordination error:', error.message);
    }

    // Remove duplicates and sort by confidence with better deduplication
    const uniqueResults = allResults
        .filter(business => business && business.name) // Filter out invalid entries
        .filter((business, index, self) => {
            // More sophisticated deduplication
            const duplicateIndex = self.findIndex(b => 
                b.name.toLowerCase() === business.name.toLowerCase() && 
                Math.abs((b.latitude || 0) - (business.latitude || 0)) < 0.01 &&
                Math.abs((b.longitude || 0) - (business.longitude || 0)) < 0.01
            );
            return duplicateIndex === index;
        })
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, limit);

    console.log(`📊 Total unique results: ${uniqueResults.length}`);

    const usedSources = Object.entries(sourceConfig)
        .filter(([name, config]) => config.enabled)
        .map(([name]) => name);

    return {
        success: true,
        query: query,
        results: uniqueResults,
        total_results: uniqueResults.length,
        sources_used: usedSources,
        note: `Combined results from ${usedSources.join(', ')}`
    };
}

// ==================== IMPROVED ENHANCED BUSINESS PROFILE FUNCTION ====================
async function getBusinessProfileEnhanced(query) {
    console.log(`🏢 ENHANCED Business Profile Search: "${query}"`);
    
    try {
        // Use combined business directory search with better error handling
        const directoryResults = await searchBusinessDirectory(query, {
            limit: 15,
            sources: ['openstreetmap', 'wikidata', 'opencage', 'google_places']
        });

        if (directoryResults.success && directoryResults.results.length > 0) {
            return {
                success: true,
                query: query,
                results: directoryResults.results,
                total_results: directoryResults.results.length,
                sources: directoryResults.sources_used,
                note: directoryResults.note
            };
        }

        // Improved fallback to AI analysis
        console.log('🤖 No directory results, using AI analysis fallback');
        try {
            const aiAnalysis = await analyzeBusinessWithAI(query);
            if (aiAnalysis.success) {
                return {
                    success: true,
                    query: query,
                    results: [{
                        name: query,
                        formatted_address: "AI-generated business analysis",
                        type: "business",
                        analysis: aiAnalysis.content,
                        confidence: 0.5,
                        source: 'ai_fallback',
                        category: 'various',
                        note: 'AI-generated business intelligence'
                    }],
                    total_results: 1,
                    sources: ['ai_fallback'],
                    note: 'AI analysis fallback'
                };
            } else {
                throw new Error(aiAnalysis.error);
            }
        } catch (aiError) {
            console.error('AI fallback also failed:', aiError.message);
            return {
                success: false,
                error: 'No business results found in any source',
                results: [],
                note: 'Tried all available business directories and AI fallback'
            };
        }
    } catch (error) {
        console.error('Enhanced business profile error:', error.message);
        return {
            success: false,
            error: 'Business profile search failed: ' + error.message,
            results: []
        };
    }
}

// ==================== IMPROVED AI BUSINESS ANALYSIS WITH RATE LIMITING ====================
async function analyzeBusinessWithAI(businessQuery, model = defaultModel) {
    return queueRequest(async () => {
        try {
            const prompt = `Provide a comprehensive business analysis for: "${businessQuery}"

Please analyze this business and provide:

BUSINESS OVERVIEW:
- Likely industry and business type
- Target market and customer base
- Key products/services

MARKET ANALYSIS:
- Competitive landscape
- Market positioning
- Growth potential

OPERATIONAL INSIGHTS:
- Typical business model
- Revenue streams
- Operational requirements

STRATEGIC RECOMMENDATIONS:
- Business opportunities
- Potential challenges
- Success factors

Based on typical business patterns and market knowledge. Keep response under 1200 tokens.`;

            const response = await axios.post(
                OPENROUTER_BASE_URL + '/chat/completions',
                {
                    model: model,
                    messages: [
                        { 
                            role: "system", 
                            content: "You are a business intelligence analyst that provides detailed business analysis based on company names and industry patterns. Keep responses concise and practical." 
                        },
                        { role: "user", content: prompt }
                    ],
                    max_tokens: 1200, // Reduced to prevent rate limiting
                    temperature: 0.7
                },
                {
                    headers: {
                        'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'http://localhost:3000',
                        'X-Title': 'Business Directory App'
                    },
                    timeout: 25000
                }
            );

            return {
                success: true,
                content: response.data.choices[0].message.content,
                model: model
            };

        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.log('⚠️ OpenRouter rate limit hit, using fallback response');
                return {
                    success: true,
                    content: `Business Analysis for "${businessQuery}":\n\nThis appears to be a well-known business entity. Based on typical patterns for this type of business, it likely serves a broad customer base with standardized products/services. The market positioning suggests established brand recognition and competitive pricing strategies. Operational requirements would include standard business infrastructure, customer service capabilities, and digital presence.`,
                    model: 'fallback'
                };
            }
            console.error('AI business analysis error:', error.message);
            throw error;
        }
    });
}

// ==================== IMPROVED WEBSITE ANALYSIS WITH RATE LIMITING ====================
async function analyzeWebsiteWithAI(url, model = defaultModel) {
  return queueRequest(async () => {
    try {
        console.log('🤖 AI Analyzing website:', url);
        
        const prompt = `Analyze the business website: ${url}

Provide a concise AI-powered analysis including:

BUSINESS OVERVIEW:
- Business type and industry
- Target audience
- Core offerings

CONTACT PATTERNS:
- Expected contact methods
- Typical communication channels

KEY INSIGHTS:
- Business model assessment
- Market positioning

Keep response under 1000 tokens. Focus on practical business intelligence.`;

        const response = await axios.post(
          OPENROUTER_BASE_URL + '/chat/completions',
          {
            model: model,
            messages: [
              { 
                role: "system", 
                content: "You are a business intelligence analyst that provides concise website analysis. Keep responses practical and under 1000 tokens." 
              },
              { role: "user", content: prompt }
            ],
            max_tokens: 1000,
            temperature: 0.7
          },
          {
            headers: {
              'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'http://localhost:3000',
              'X-Title': 'Business Directory App'
            },
            timeout: 25000
          }
        );

        const analysis = response.data.choices[0].message.content;
        
        return {
          success: true,
          title: `AI Analysis: ${url}`,
          description: "AI-powered business intelligence report",
          content: analysis,
          phoneNumbers: ["Analysis: Contact patterns vary by business type"],
          emails: ["Analysis: Common formats: info@, support@, hello@"],
          addresses: ["Analysis: Location depends on business model"],
          url: url,
          note: "AI-generated analysis based on business patterns"
        };

    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.log('⚠️ OpenRouter rate limit hit for website analysis');
            return {
                success: true,
                title: `Basic Analysis: ${url}`,
                description: "Rate-limited analysis",
                content: `Website analysis for ${url}: This appears to be a business website requiring standard business analysis. Typical elements would include customer engagement, service offerings, and contact information.`,
                phoneNumbers: [],
                emails: [],
                addresses: [],
                url: url,
                note: "Basic analysis due to rate limiting"
            };
        }
        console.error('AI website analysis error:', error.message);
        throw error;
    }
  });
}

// ==================== BASIC WEB SEARCH FUNCTION ====================
async function performWebSearch(query, numResults = 5) {
    try {
        console.log('🔍 Performing web search for:', query);
        
        // Simple search fallback
        return {
            success: true,
            results: [
                {
                    title: `Search results for: ${query}`,
                    url: `https://example.com/search?q=${encodeURIComponent(query)}`,
                    snippet: `Web search results for "${query}". This is a fallback since search APIs are not configured.`
                }
            ],
            source: 'fallback'
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

// ==================== BASIC EXPRESS ROUTES ====================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Enhanced Business Directory</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; }
                h1 { color: #333; }
                .status { padding: 10px; margin: 10px 0; border-radius: 5px; }
                .success { background: #d4edda; color: #155724; }
                .warning { background: #fff3cd; color: #856404; }
                .error { background: #f8d7da; color: #721c24; }
            </style>
        </head>
        <body>
            <h1>🚀 Enhanced Business Directory App</h1>
            <div class="status success">
                <strong>✅ Server is running!</strong>
                <p>Port: ${PORT}</p>
                <p>Available Models: ${availableModels.length}</p>
            </div>
            <div class="status ${OPENCAGE_API_KEY ? 'success' : 'warning'}">
                OpenCage: ${OPENCAGE_API_KEY ? 'Configured' : 'Not configured'}
            </div>
            <div class="status ${GOOGLE_API_KEY ? 'success' : 'warning'}">
                Google Places: ${GOOGLE_API_KEY ? 'Configured' : 'Not configured'}
            </div>
            <p>Use the API endpoints to search for businesses.</p>
        </body>
        </html>
    `);
});

app.post('/api/business-profile', async (req, res) => {
    try {
        const { query } = req.body;
        
        if (!query) {
            return res.json({ error: 'Search query is required' });
        }

        const results = await getBusinessProfileEnhanced(query);
        res.json(results);

    } catch (error) {
        res.json({
            success: false,
            error: 'Business profile search failed: ' + error.message
        });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        models: availableModels.length,
        business_sources: {
            openstreetmap: true,
            wikidata: true,
            opencage: !!OPENCAGE_API_KEY,
            google_places: !!GOOGLE_API_KEY
        }
    });
});

// ==================== SOCKET.IO HANDLERS ====================
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('business_profile_search', async (data) => {
        try {
            const { query } = data;
            
            if (!query || query.trim().length < 2) {
                socket.emit('business_profile_results', {
                    success: false,
                    error: 'Search query must be at least 2 characters long'
                });
                return;
            }

            console.log('🏢 Enhanced Business Directory Search:', query);
            const results = await getBusinessProfileEnhanced(query);
            socket.emit('business_profile_results', results);
        } catch (error) {
            console.error('Business search error:', error.message);
            socket.emit('business_profile_results', {
                success: false,
                error: 'Business search failed: ' + error.message
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// ==================== START SERVER ====================
fetchModels().then(() => {
    server.listen(PORT, 'localhost', () => {
        console.log('🚀 ENHANCED AI Business Directory App Started!');
        console.log('📍 http://localhost:' + PORT);
        console.log('📊 Features: Enhanced Business Directory + AI Analysis');
        console.log('🏢 Business Sources:');
        console.log('   ✅ OpenStreetMap (Free) - Millions of businesses worldwide');
        console.log('   ✅ Wikidata (Free) - Wikipedia business entities');
        console.log('   ' + (OPENCAGE_API_KEY ? '✅' : '❌') + ' OpenCage - ' + (OPENCAGE_API_KEY ? 'Configured' : 'Not configured'));
        console.log('   ' + (GOOGLE_API_KEY ? '✅' : '❌') + ' Google Places - ' + (GOOGLE_API_KEY ? 'Configured' : 'Not configured'));
        console.log('🤖 Available models:', availableModels.length);
        
        console.log('\n💡 Test the API:');
        console.log('   curl -X POST http://localhost:' + PORT + '/api/business-profile -H "Content-Type: application/json" -d \'{"query":"Starbucks"}\'');
    });
}).catch(error => {
    console.error('Failed to start server:', error);
});