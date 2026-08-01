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

// ==================== OPENSTREETMAP BUSINESS SEARCH ====================
async function getBusinessesFromOSM(query, location = '', category = '') {
    try {
        console.log('🏢 Searching OpenStreetMap for:', query);
        
        // Build Overpass API query
        let overpassQuery = `
            [out:json][timeout:30];
            (
              node["name"~"${query}", i]["shop"];
              node["name"~"${query}", i]["amenity"];
              node["name"~"${query}", i]["office"];
              node["name"~"${query}", i]["craft"];
              node["name"~"${query}", i]["tourism"];
              node["name"~"${query}", i]["leisure"];
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
                timeout: 30000
            }
        );

        if (response.data && response.data.elements) {
            const businesses = response.data.elements
                .filter(element => element.tags && element.tags.name)
                .map(element => {
                    const tags = element.tags;
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
                        latitude: element.lat,
                        longitude: element.lon,
                        phone: tags.phone,
                        website: tags.website,
                        email: tags.email,
                        opening_hours: tags.opening_hours,
                        confidence: 0.7, // OSM data is generally reliable
                        source: 'openstreetmap',
                        category: tags.shop || tags.amenity || 'business'
                    };
                });

            return {
                success: true,
                results: businesses,
                total: businesses.length
            };
        }

        return { success: false, error: 'No businesses found in OpenStreetMap', results: [] };
    } catch (error) {
        console.error('OSM search error:', error.message);
        return { success: false, error: 'OpenStreetMap search failed: ' + error.message, results: [] };
    }
}

// ==================== WIKIDATA BUSINESS SEARCH ====================
async function getBusinessesFromWikidata(query) {
    try {
        console.log('📚 Searching Wikidata for:', query);
        
        // Search for businesses in Wikidata
        const searchResponse = await axios.get('https://www.wikidata.org/w/api.php', {
            params: {
                action: 'wbsearchentities',
                search: query,
                language: 'en',
                format: 'json',
                type: 'item',
                limit: 10
            },
            timeout: 15000
        });

        if (searchResponse.data.search) {
            const businesses = [];
            
            for (const item of searchResponse.data.search.slice(0, 5)) { // Limit to 5 for performance
                try {
                    const entityResponse = await axios.get(
                        `https://www.wikidata.org/wiki/Special:EntityData/${item.id}.json`,
                        { timeout: 10000 }
                    );
                    
                    const entity = entityResponse.data.entities[item.id];
                    const claims = entity.claims || {};
                    
                    // Extract website
                    let website = '';
                    if (claims.P856 && claims.P856[0]) {
                        website = claims.P856[0].mainsnak.datavalue?.value;
                    }
                    
                    // Extract headquarters location
                    let location = '';
                    if (claims.P159 && claims.P159[0]) {
                        const locationId = claims.P159[0].mainsnak.datavalue?.value.id;
                        if (locationId) {
                            // Could further resolve location details here
                            location = `Headquarters: ${locationId}`;
                        }
                    }
                    
                    businesses.push({
                        name: item.label,
                        description: item.description || 'Business entity',
                        type: 'company',
                        formatted_address: location,
                        website: website,
                        confidence: 0.6,
                        source: 'wikidata',
                        category: 'corporation',
                        note: 'Wikipedia business entity'
                    });
                } catch (error) {
                    console.log(`Skipping Wikidata entity ${item.id}:`, error.message);
                }
            }

            return {
                success: true,
                results: businesses.filter(b => b.name),
                total: businesses.length
            };
        }

        return { success: false, error: 'No businesses found in Wikidata', results: [] };
    } catch (error) {
        console.error('Wikidata search error:', error.message);
        return { success: false, error: 'Wikidata search failed: ' + error.message, results: [] };
    }
}

// ==================== GOOGLE PLACES BUSINESS SEARCH ====================
async function getBusinessesFromGooglePlaces(query, location = '') {
    try {
        if (!GOOGLE_API_KEY) {
            return { success: false, error: 'Google API key not configured' };
        }

        console.log('🔍 Searching Google Places for:', query);
        
        const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
            params: {
                query: query + (location ? ` in ${location}` : ''),
                key: GOOGLE_API_KEY,
                type: 'establishment'
            },
            timeout: 15000
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
                confidence: 0.9, // Google Places data is high quality
                source: 'google_places',
                category: place.types?.[0] || 'business'
            }));

            return {
                success: true,
                results: businesses,
                total: businesses.length
            };
        }

        return { success: false, error: 'No businesses found in Google Places', results: [] };
    } catch (error) {
        console.error('Google Places error:', error.message);
        return { success: false, error: 'Google Places search failed: ' + error.message, results: [] };
    }
}

// ==================== OPEN CAGE BUSINESS SEARCH ====================
async function getBusinessesFromOpenCage(query) {
    if (!OPENCAGE_API_KEY) {
        return { success: false, error: 'OpenCage API key not configured' };
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
            timeout: 15000
        });
        
        if (response.data.results && response.data.results.length > 0) {
            const results = response.data.results
                .filter(result => result.components)
                .map((result) => {
                    const components = result.components;
                    return {
                        name: components.company || components.business || components.shop || components.office || query,
                        formatted_address: result.formatted,
                        street: components.road,
                        city: components.city,
                        state: components.state,
                        country: components.country,
                        postcode: components.postcode,
                        latitude: result.geometry.lat,
                        longitude: result.geometry.lng,
                        phone: components.phone,
                        website: components.website,
                        confidence: result.confidence / 10, // Convert to 0-1 scale
                        type: components._type || components.type,
                        source: 'opencage',
                        category: components._category || 'business'
                    };
                })
                .filter(result => result.confidence > 0.3); // Filter out low-confidence results

            return {
                success: true,
                results: results,
                total_results: results.length
            };
        } else {
            return {
                success: false,
                error: 'No business results found in OpenCage'
            };
        }
    } catch (error) {
        console.error('OpenCage API error:', error.message);
        return {
            success: false,
            error: 'OpenCage search failed: ' + error.message
        };
    }
}

// ==================== COMBINED BUSINESS DIRECTORY SEARCH ====================
async function searchBusinessDirectory(query, options = {}) {
    const {
        location = '',
        limit = 15,
        sources = ['openstreetmap', 'wikidata', 'opencage', 'google_places']
    } = options;

    console.log(`🔍 Comprehensive business search for: "${query}"`);

    const searchPromises = [];
    const allResults = [];

    // OpenStreetMap search (always free)
    if (sources.includes('openstreetmap')) {
        searchPromises.push(
            getBusinessesFromOSM(query, location)
                .then(result => {
                    if (result.success) {
                        console.log(`✅ OpenStreetMap found: ${result.results.length} results`);
                        allResults.push(...result.results);
                    }
                })
                .catch(error => console.error('OSM search failed:', error.message))
        );
    }

    // Wikidata search (always free)
    if (sources.includes('wikidata')) {
        searchPromises.push(
            getBusinessesFromWikidata(query)
                .then(result => {
                    if (result.success) {
                        console.log(`✅ Wikidata found: ${result.results.length} results`);
                        allResults.push(...result.results);
                    }
                })
                .catch(error => console.error('Wikidata search failed:', error.message))
        );
    }

    // OpenCage search (if API key available)
    if (sources.includes('opencage') && OPENCAGE_API_KEY) {
        searchPromises.push(
            getBusinessesFromOpenCage(query)
                .then(result => {
                    if (result.success) {
                        console.log(`✅ OpenCage found: ${result.results.length} results`);
                        allResults.push(...result.results);
                    }
                })
                .catch(error => console.error('OpenCage search failed:', error.message))
        );
    }

    // Google Places search (if API key available)
    if (sources.includes('google_places') && GOOGLE_API_KEY) {
        searchPromises.push(
            getBusinessesFromGooglePlaces(query, location)
                .then(result => {
                    if (result.success) {
                        console.log(`✅ Google Places found: ${result.results.length} results`);
                        allResults.push(...result.results);
                    }
                })
                .catch(error => console.error('Google Places search failed:', error.message))
        );
    }

    // Wait for all searches to complete
    await Promise.allSettled(searchPromises);

    // Remove duplicates and sort by confidence
    const uniqueResults = allResults
        .filter((business, index, self) =>
            index === self.findIndex(b => 
                b.name === business.name && 
                JSON.stringify(b.coordinates) === JSON.stringify(business.coordinates)
            )
        )
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, limit);

    console.log(`📊 Total unique results: ${uniqueResults.length}`);

    return {
        success: true,
        query: query,
        results: uniqueResults,
        total_results: uniqueResults.length,
        sources_used: sources.filter(src => {
            if (src === 'opencage') return !!OPENCAGE_API_KEY;
            if (src === 'google_places') return !!GOOGLE_API_KEY;
            return true;
        })
    };
}

// ==================== ENHANCED BUSINESS PROFILE FUNCTION ====================
async function getBusinessProfileEnhanced(query) {
    console.log(`🏢 ENHANCED Business Profile Search: "${query}"`);
    
    // Use combined business directory search
    const directoryResults = await searchBusinessDirectory(query, {
        limit: 12,
        sources: ['openstreetmap', 'wikidata', 'opencage', 'google_places']
    });

    if (directoryResults.success && directoryResults.results.length > 0) {
        return {
            success: true,
            query: query,
            results: directoryResults.results,
            total_results: directoryResults.results.length,
            sources: directoryResults.sources_used,
            note: `Combined results from ${directoryResults.sources_used.join(', ')}`
        };
    }

    // Fallback to AI analysis if no directory results
    console.log('🤖 No directory results, using AI analysis fallback');
    try {
        const aiAnalysis = await analyzeBusinessWithAI(query);
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
    } catch (error) {
        return {
            success: false,
            error: 'No business results found and AI analysis failed: ' + error.message,
            results: []
        };
    }
}

// ==================== AI BUSINESS ANALYSIS FALLBACK ====================
async function analyzeBusinessWithAI(businessQuery, model = defaultModel) {
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

Based on typical business patterns and market knowledge.`;

        const response = await axios.post(
            OPENROUTER_BASE_URL + '/chat/completions',
            {
                model: model,
                messages: [
                    { 
                        role: "system", 
                        content: "You are a business intelligence analyst that provides detailed business analysis based on company names and industry patterns." 
                    },
                    { role: "user", content: prompt }
                ],
                max_tokens: 1500,
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
            content: response.data.choices[0].message.content,
            model: model
        };

    } catch (error) {
        console.error('AI business analysis error:', error.message);
        return {
            success: false,
            error: 'AI analysis failed: ' + error.message
        };
    }
}

// ==================== ENHANCED WEB SEARCH ====================
async function performWebSearch(query, numResults = 5) {
    try {
        console.log('🔍 Performing web search for:', query);
        
        // Method 1: Using Google Custom Search
        if (GOOGLE_CSE_ID && GOOGLE_API_KEY) {
            try {
                const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
                    params: {
                        q: query,
                        cx: GOOGLE_CSE_ID,
                        key: GOOGLE_API_KEY,
                        num: Math.min(numResults, 10)
                    },
                    timeout: 15000
                });
                
                if (response.data && response.data.items) {
                    return {
                        success: true,
                        results: response.data.items.slice(0, numResults).map(item => ({
                            title: item.title,
                            url: item.link,
                            snippet: item.snippet
                        })),
                        source: 'google_cse'
                    };
                }
            } catch (googleError) {
                console.log('Google CSE failed:', googleError.message);
            }
        }
        
        // Method 2: Using SerpAPI
        if (SERPAPI_KEY) {
            try {
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
            } catch (serpError) {
                console.log('SerpAPI failed:', serpError.message);
            }
        }
        
        // Method 3: AI-powered search fallback
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
            results: [{ 
                title: "AI-Generated Search Results", 
                url: "", 
                snippet: searchResponse.data.choices[0].message.content 
            }],
            source: 'ai_fallback'
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

// ==================== WEBSITE ANALYSIS ====================
async function analyzeWebsiteWithAI(url, model = defaultModel) {
  try {
    console.log('🤖 AI Analyzing website:', url);
    
    const prompt = `Analyze the business website: ${url}

Please provide a comprehensive AI-powered analysis including:

## 🌐 WEBSITE OVERVIEW
- Business type and industry classification
- Target audience and market positioning  
- Core products/services offered

## 📞 EXPECTED CONTACT PATTERNS
Based on typical business structures, what contact methods would this type of business likely have?
- Common phone number formats for this industry
- Typical email patterns (info@, support@, sales@, etc.)
- Physical location considerations

## 💼 BUSINESS INTELLIGENCE
- Business model assessment
- Revenue stream possibilities
- Competitive advantages
- Market positioning analysis

## 📈 STRATEGIC INSIGHTS
- Growth opportunities
- Business development suggestions
- Operational improvements

Provide realistic, practical business intelligence based on the website domain and industry patterns.`;

    const response = await axios.post(
      OPENROUTER_BASE_URL + '/chat/completions',
      {
        model: model,
        messages: [
          { 
            role: "system", 
            content: "You are a business intelligence analyst that provides detailed website analysis based on domain names and industry patterns." 
          },
          { role: "user", content: prompt }
        ],
        max_tokens: 2000,
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

    const analysis = response.data.choices[0].message.content;
    
    return {
      success: true,
      title: `AI Analysis: ${url}`,
      description: "AI-powered business intelligence report",
      content: analysis,
      phoneNumbers: ["AI Analysis: Contact patterns vary by business type"],
      emails: ["AI Analysis: Common email formats: info@, support@, hello@"],
      addresses: ["AI Analysis: Location depends on business model"],
      url: url,
      note: "This is an AI-generated analysis based on business patterns"
    };

  } catch (error) {
    console.error('AI website analysis error:', error.message);
    return {
      success: false,
      error: 'AI analysis failed: ' + error.message,
      title: "Analysis Failed",
      description: "Could not analyze website",
      phoneNumbers: [],
      emails: [],
      addresses: [],
      url: url
    };
  }
}

// ==================== BUSINESS ANALYSIS FUNCTIONS ====================
async function generateQuickAnalysis(websiteData, model = defaultModel) {
    try {
        const prompt = `Provide a quick business analysis based on this AI-generated website intelligence:

Website: ${websiteData.url}
Analysis Type: ${websiteData.note || 'AI-Powered Business Intelligence'}

AI Analysis Content:
${websiteData.content}

Provide a brief 3-paragraph analysis covering:
1. What type of business this appears to be based on AI analysis
2. Key strengths or unique value propositions identified
3. One immediate recommendation

Keep it concise and practical.`;

        const response = await axios.post(
            OPENROUTER_BASE_URL + '/chat/completions',
            {
                model: model,
                messages: [
                    { 
                        role: "system", 
                        content: "You are a business consultant who provides quick, practical business analysis based on AI intelligence." 
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
        const prompt = `Create a comprehensive business analysis report based on AI intelligence:

URL: ${websiteData.url}
Analysis Source: ${websiteData.note || 'AI-Powered Market Intelligence'}

AI Analysis Data:
${websiteData.content}

Please provide a structured report with these sections:

BUSINESS OVERVIEW
- Type of business based on AI analysis
- Target audience assessment
- Core offerings identified

KEY OBSERVATIONS
- Notable strengths from AI analysis
- Potential weaknesses or gaps
- Market positioning

RECOMMENDATIONS
- 3 actionable suggestions based on AI insights
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
                        content: "You create clear, actionable business analysis reports based on AI intelligence." 
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

// ==================== SEARCH AND ANALYZE FUNCTION ====================
async function searchAndAnalyze(searchQuery, model = defaultModel) {
    try {
        console.log('Starting search and analysis for:', searchQuery);
        
        const searchResults = await performWebSearch(searchQuery, 3);
        
        if (!searchResults.success) {
            return {
                success: false,
                error: 'Search failed: ' + searchResults.error
            };
        }

        let analysisResults = [];
        
        for (const result of searchResults.results) {
            if (result.url && result.url.startsWith('http')) {
                try {
                    const websiteData = await analyzeWebsiteWithAI(result.url, model);
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
                const analysis = await generateQuickAnalysis({
                    success: true,
                    title: result.title,
                    description: "AI-generated search result",
                    content: result.snippet,
                    phoneNumbers: [],
                    emails: [],
                    addresses: [],
                    url: searchQuery,
                    note: "AI-generated search analysis"
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

// ==================== LOCATION SERVICES ====================
async function getLocationData(location, service = 'openstreetmap') {
    try {
        console.log('🗺️ Getting location data for:', location);
        
        if (service === 'openstreetmap') {
            const response = await axios.get('https://nominatim.openstreetmap.org/search', {
                params: {
                    q: location,
                    format: 'json',
                    limit: 5,
                    addressdetails: 1
                },
                timeout: 10000
            });
            
            if (response.data && response.data.length > 0) {
                const results = response.data.map(item => ({
                    name: item.display_name,
                    lat: parseFloat(item.lat),
                    lon: parseFloat(item.lon),
                    type: item.type,
                    importance: item.importance,
                    address: item.address
                }));
                
                return {
                    success: true,
                    service: 'openstreetmap',
                    results: results
                };
            }
        }
        
        // AI fallback
        const locationPrompt = `Analyze the location/business: "${location}". Provide information about:
        - Likely type of business or location
        - Potential coordinates or area
        - Business context and significance
        - Any notable features or characteristics`;
        
        const aiResponse = await axios.post(
            OPENROUTER_BASE_URL + '/chat/completions',
            {
                model: defaultModel,
                messages: [
                    { 
                        role: "system", 
                        content: "You are a location intelligence analyst that provides detailed location analysis." 
                    },
                    { role: "user", content: locationPrompt }
                ],
                max_tokens: 500,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 20000
            }
        );

        return {
            success: true,
            service: 'ai_fallback',
            results: [{
                name: location,
                analysis: aiResponse.data.choices[0].message.content,
                note: "AI-generated location analysis"
            }]
        };

    } catch (error) {
        console.error('Location data error:', error.message);
        return {
            success: false,
            error: 'Location lookup failed: ' + error.message
        };
    }
}

// ==================== UNIFIED AI CHAT PROCESSOR ====================
async function processUnifiedChat(message, model = defaultModel, sessionId = 'default') {
    try {
        console.log('🤖 Unified AI Chat Processing:', message);
        
        const lowerMessage = message.toLowerCase();
        
        // Business Profile Search
        if (lowerMessage.includes('business profile') || lowerMessage.includes('find business') || 
            lowerMessage.includes('company information') || lowerMessage.includes('get business') ||
            lowerMessage.includes('business search') || lowerMessage.includes('find company')) {
            
            let query = message.replace(/business profile|find business|company information|get business|business search|find company/gi, '').trim();
            if (query.length > 2) {
                const businessResults = await getBusinessProfileEnhanced(query);
                
                if (businessResults.success) {
                    let response = `🏢 **Enhanced Business Directory Search for "${query}"**\n\n`;
                    response += `📊 **Found ${businessResults.total_results} results from:** ${businessResults.sources?.join(', ') || 'multiple sources'}\n\n`;
                    
                    businessResults.results.forEach((result, index) => {
                        response += `---\n`;
                        response += `**${index + 1}. ${result.name}**\n`;
                        response += `📍 **Address:** ${result.formatted_address || 'Not specified'}\n`;
                        
                        if (result.street) {
                            response += `🏠 **Street:** ${result.street}\n`;
                        }
                        if (result.city) {
                            response += `🏙️ **City:** ${result.city}\n`;
                        }
                        if (result.state) {
                            response += `🗺️ **State:** ${result.state}\n`;
                        }
                        if (result.country) {
                            response += `🌍 **Country:** ${result.country}\n`;
                        }
                        if (result.phone) {
                            response += `📞 **Phone:** ${result.phone}\n`;
                        }
                        if (result.website) {
                            response += `🔗 **Website:** ${result.website}\n`;
                        }
                        if (result.email) {
                            response += `📧 **Email:** ${result.email}\n`;
                        }
                        if (result.type) {
                            response += `🏷️ **Type:** ${result.type}\n`;
                        }
                        if (result.rating) {
                            response += `⭐ **Rating:** ${result.rating}/5 (${result.total_ratings} reviews)\n`;
                        }
                        
                        response += `🎯 **Confidence:** ${Math.round((result.confidence || 0.5) * 100)}%\n`;
                        response += `📊 **Source:** ${result.source}\n\n`;
                    });
                    
                    return {
                        type: 'business_profile',
                        success: true,
                        message: response,
                        data: businessResults,
                        model: model
                    };
                } else {
                    return {
                        type: 'business_profile',
                        success: false,
                        message: `❌ ${businessResults.error || 'No business profile found'}`,
                        error: businessResults.error
                    };
                }
            }
        }
        
        // [Rest of the chat processor remains similar but uses enhanced functions...]
        // Website analysis intent
        if (lowerMessage.includes('analyze website') || lowerMessage.includes('website analysis') || 
            (lowerMessage.includes('http') && (lowerMessage.includes('.com') || lowerMessage.includes('.org') || lowerMessage.includes('.net')))) {
            
            let url = message.match(/(https?:\/\/[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/g)?.[0];
            if (!url && (lowerMessage.includes('analyze') || lowerMessage.includes('website'))) {
                const words = message.split(' ');
                for (const word of words) {
                    if (word.includes('.') && !word.includes(' ')) {
                        url = word;
                        break;
                    }
                }
            }
            
            if (url) {
                if (!url.startsWith('http')) {
                    url = 'https://' + url;
                }
                
                const websiteData = await analyzeWebsiteWithAI(url, model);
                if (websiteData.success) {
                    const quickAnalysis = await generateQuickAnalysis(websiteData, model);
                    
                    return {
                        type: 'website_analysis',
                        success: true,
                        message: `🌐 **Website Analysis Complete for ${url}**\n\n` +
                                `📊 **Quick Analysis:**\n${quickAnalysis.analysis}\n\n` +
                                `📋 **Full Analysis Available:**\n${websiteData.content.substring(0, 500)}...\n\n` +
                                `💡 *Use "generate detailed report for ${url}" for comprehensive business intelligence.*`,
                        data: websiteData,
                        model: model
                    };
                }
            }
        }
        
        // Business report intent
        if (lowerMessage.includes('generate report') || lowerMessage.includes('business report') || 
            lowerMessage.includes('detailed report')) {
            
            let url = message.match(/(https?:\/\/[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/g)?.[0];
            if (url) {
                if (!url.startsWith('http')) {
                    url = 'https://' + url;
                }
                
                const websiteData = await analyzeWebsiteWithAI(url, model);
                if (websiteData.success) {
                    const report = await generateBusinessReport(websiteData, model);
                    
                    return {
                        type: 'business_report',
                        success: true,
                        message: `📊 **Comprehensive Business Report for ${url}**\n\n${report.report}`,
                        data: report,
                        model: model
                    };
                }
            }
        }
        
        // Web search intent
        if (lowerMessage.includes('search for') || lowerMessage.includes('find information about') || 
            lowerMessage.includes('web search') || (lowerMessage.includes('what is') && lowerMessage.length > 20)) {
            
            const searchQuery = message.replace(/search for|find information about|web search/i, '').trim();
            if (searchQuery.length > 3) {
                const searchResults = await performWebSearch(searchQuery, 3);
                
                if (searchResults.success) {
                    let searchResponse = `🔍 **Web Search Results for "${searchQuery}"**\n\n`;
                    
                    searchResults.results.forEach((result, index) => {
                        searchResponse += `**${index + 1}. ${result.title}**\n`;
                        if (result.url) {
                            searchResponse += `🔗 ${result.url}\n`;
                        }
                        searchResponse += `📝 ${result.snippet}\n\n`;
                    });
                    
                    searchResponse += `💡 *Want to analyze any of these websites? Just say "analyze [website-url]"*`;
                    
                    return {
                        type: 'web_search',
                        success: true,
                        message: searchResponse,
                        data: searchResults,
                        model: model
                    };
                }
            }
        }
        
        // Location/map search intent
        if (lowerMessage.includes('location of') || lowerMessage.includes('map for') || 
            lowerMessage.includes('find') && (lowerMessage.includes('near me') || lowerMessage.includes('in ') && lowerMessage.split(' ').length > 3)) {
            
            const locationQuery = message.replace(/location of|map for|find/i, '').replace('near me', '').trim();
            if (locationQuery.length > 2) {
                const locationData = await getLocationData(locationQuery);
                
                if (locationData.success) {
                    let locationResponse = `🗺️ **Location Results for "${locationQuery}"**\n\n`;
                    
                    locationData.results.slice(0, 3).forEach((result, index) => {
                        locationResponse += `**${index + 1}. ${result.name}**\n`;
                        if (result.lat && result.lon) {
                            locationResponse += `📍 Coordinates: ${result.lat}, ${result.lon}\n`;
                        }
                        if (result.address) {
                            locationResponse += `🏠 Address: ${typeof result.address === 'object' ? JSON.stringify(result.address) : result.address}\n`;
                        }
                        if (result.analysis) {
                            locationResponse += `📋 Analysis: ${result.analysis.substring(0, 200)}...\n`;
                        }
                        locationResponse += '\n';
                    });
                    
                    return {
                        type: 'location_search',
                        success: true,
                        message: locationResponse,
                        data: locationData,
                        model: model
                    };
                }
            }
        }
        
        // Search and analyze intent
        if (lowerMessage.includes('search and analyze') || lowerMessage.includes('find and analyze') || 
            (lowerMessage.includes('analyze') && lowerMessage.includes('businesses'))) {
            
            const query = message.replace(/search and analyze|find and analyze|analyze businesses?/i, '').trim();
            if (query.length > 3) {
                const results = await searchAndAnalyze(query, model);
                
                if (results.success) {
                    let analysisResponse = `🤖 **Search & Analysis for "${query}"**\n\n`;
                    
                    results.analysisResults.forEach((result, index) => {
                        analysisResponse += `---\n`;
                        if (result.searchResult.url) {
                            analysisResponse += `**Website:** ${result.searchResult.title || result.searchResult.url}\n`;
                            analysisResponse += `🔗 ${result.searchResult.url}\n`;
                        } else {
                            analysisResponse += `**Result:** ${result.searchResult.title}\n`;
                        }
                        
                        if (result.analysis && result.analysis.success) {
                            analysisResponse += `📊 **Analysis:** ${result.analysis.analysis}\n\n`;
                        } else if (result.error) {
                            analysisResponse += `❌ Analysis failed: ${result.error}\n\n`;
                        }
                    });
                    
                    return {
                        type: 'search_analyze',
                        success: true,
                        message: analysisResponse,
                        data: results,
                        model: model
                    };
                }
            }
        }
        
        // Default AI chat response
        if (!conversations.has(sessionId)) {
            conversations.set(sessionId, []);
        }
        const conversation = conversations.get(sessionId);

        const messages = [
            { 
                role: "system", 
                content: `You are a comprehensive AI business assistant with enhanced capabilities:

Available Functions:
1. 🏢 Business Profile - Enhanced directory search (OpenStreetMap, Wikidata, OpenCage, Google Places)
2. 🌐 Website Analysis - Analyze any website for business intelligence
3. 🔍 Web Search - Search the web for information
4. 📊 Business Reports - Generate detailed business analysis reports
5. 🗺️ Location Search - Find and analyze business locations
6. 🤖 Search & Analyze - Combined web search and business analysis

Enhanced Business Directory includes:
• OpenStreetMap (Free) - Millions of businesses worldwide
• Wikidata (Free) - Wikipedia business entities
• OpenCage (If configured) - Business geocoding
• Google Places (If configured) - Business listings

When users ask for specific functions, guide them to use natural commands like:
- "business profile Starbucks"
- "find business Apple Store"
- "analyze apple.com"
- "search for coffee shops in Seattle"
- "generate business report for microsoft.com"
- "find tech companies in San Francisco"
- "search and analyze local restaurants"

Provide helpful, comprehensive responses and suggest relevant capabilities.`
            },
            ...conversation.slice(-4),
            { role: "user", content: message }
        ];

        const response = await axios.post(
            OPENROUTER_BASE_URL + '/chat/completions',
            {
                model: model,
                messages: messages,
                max_tokens: 1500,
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

        return {
            type: 'general_chat',
            success: true,
            message: aiMessage,
            model: model
        };

    } catch (error) {
        console.error('Unified chat processing error:', error.message);
        return {
            type: 'error',
            success: false,
            error: 'Processing failed: ' + error.message
        };
    }
}

// ========== HTTP ROUTES ==========
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
        .chat-area {
            flex: 1; background: white; border: 1px solid #e1e8ed;
            border-radius: 10px; padding: 20px; overflow-y: auto;
            margin-bottom: 15px;
        }
        .message {
            margin: 12px 0; padding: 15px; border-radius: 12px;
            max-width: 90%; line-height: 1.5;
            white-space: pre-wrap;
        }
        .user-message {
            background: #007bff; color: white; margin-left: auto;
        }
        .ai-message {
            background: #f8f9fa; border: 1px solid #e1e8ed;
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
        .capability-badge {
            display: inline-block; background: #3498db; color: white;
            padding: 4px 8px; border-radius: 12px; font-size: 0.7em;
            margin: 2px; font-weight: bold;
        }
        .business-profile {
            background: #e8f5e9; border: 1px solid #c8e6c9; 
            padding: 15px; border-radius: 8px; margin: 10px 0;
        }
        .search-result {
            background: #fff3e0; border: 1px solid #ffb74d; 
            padding: 15px; border-radius: 8px; margin: 10px 0;
        }
        .status-indicator {
            display: inline-block; width: 8px; height: 8px; border-radius: 50%;
            margin-right: 5px;
        }
        .status-active { background: #4caf50; }
        .status-inactive { background: #f44336; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🤖 AI Business Analysis App</h1>
            <p>Enhanced Business Directory + AI Analysis + Free Data Sources</p>
        </header>
        
        <div class="tabs">
            <button class="tab active" onclick="switchTab('chat')">💬 AI Chat</button>
            <button class="tab" onclick="switchTab('search')">🔍 Web Search</button>
        </div>

        <!-- AI Chat Tab -->
        <div id="chat-tab" class="tab-content active">
            <div class="controls">
                <select id="modelSelect">` + modelsOptions + `</select>
                <button onclick="clearChat()">Clear Chat</button>
            </div>
            <div class="chat-area" id="chatArea">
                <div class="message ai-message">
                    <strong>🚀 Enhanced Business Directory App!</strong><br><br>
                    <strong>🏢 MULTI-SOURCE BUSINESS DIRECTORY:</strong><br>
                    • <span class="status-indicator status-active"></span> OpenStreetMap (Free) - Millions of businesses<br>
                    • <span class="status-indicator status-active"></span> Wikidata (Free) - Wikipedia business data<br>
                    • <span class="status-indicator status-` + (OPENCAGE_API_KEY ? 'active' : 'inactive') + `"></span> OpenCage - ` + (OPENCAGE_API_KEY ? 'Active' : 'Not configured') + `<br>
                    • <span class="status-indicator status-` + (GOOGLE_API_KEY ? 'active' : 'inactive') + `"></span> Google Places - ` + (GOOGLE_API_KEY ? 'Active' : 'Not configured') + `<br><br>
                    <strong>🔑 OpenRouter API: Active | Models: ` + availableModels.length + `</strong><br>
                    <strong>💡 Try: "business profile Starbucks" or "find business Apple Store"</strong>
                </div>
            </div>
            <div class="typing" id="typingIndicator">AI is analyzing...</div>
            <div style="display: flex; gap: 10px;">
                <input type="text" id="messageInput" placeholder="Ask anything: business profile, analyze website, search..." style="flex: 1;" onkeypress="handleKeyPress(event)">
                <button onclick="sendMessage()">Send</button>
            </div>
        </div>

        <!-- Web Search Tab -->
        <div id="search-tab" class="tab-content">
            <div class="controls">
                <div style="display: flex; gap: 10px; align-items: center;">
                    <input type="text" id="searchQuery" placeholder="Enter business name (e.g., Starbucks, Apple Store)" style="flex: 1;">
                    <select id="searchModel">` + modelsOptions + `</select>
                </div>
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button onclick="performSearch()">🔍 Search Web</button>
                    <button onclick="searchAndAnalyze()">🤖 Search & Analyze</button>
                    <button onclick="businessProfileSearch()">🏢 Business Profile</button>
                </div>
                <div style="margin-top: 10px; padding: 10px; background: #e3f2fd; border-radius: 5px; font-size: 0.9em;">
                    <strong>🏢 Enhanced Business Directory:</strong><br>
                    • OpenStreetMap (Free) • Wikidata (Free) • OpenCage • Google Places
                </div>
            </div>
            <div class="chat-area" id="searchArea">
                <div class="message ai-message">
                    <strong>Enhanced Business Directory & Search</strong><br><br>
                    Search across multiple business directories including free open-source data from OpenStreetMap and Wikidata.
                </div>
            </div>
            <div class="loading" id="searchLoading">Searching across business directories...</div>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let sessionId = 'session_' + Date.now();

        // Socket event handlers
        socket.on('unified_chat_response', (data) => {
            document.getElementById('typingIndicator').style.display = 'none';
            
            if (data.success) {
                let messageClass = 'ai-message';
                let badge = '';
                
                if (data.type === 'business_profile') {
                    badge = '<span class="capability-badge">🏢 Business Profile</span> ';
                } else if (data.type === 'website_analysis') {
                    badge = '<span class="capability-badge">🌐 Website Analysis</span> ';
                } else if (data.type === 'business_report') {
                    badge = '<span class="capability-badge">📊 Business Report</span> ';
                } else if (data.type === 'web_search') {
                    badge = '<span class="capability-badge">🔍 Web Search</span> ';
                } else if (data.type === 'location_search') {
                    badge = '<span class="capability-badge">🗺️ Location Search</span> ';
                } else if (data.type === 'search_analyze') {
                    badge = '<span class="capability-badge">🤖 Search & Analyze</span> ';
                } else {
                    badge = '<span class="capability-badge">💬 AI Chat</span> ';
                }
                
                addMessage(badge + data.message, 'ai', data.model, 'chatArea');
            } else {
                addMessage('❌ Error: ' + data.error, 'error', null, 'chatArea');
            }
        });

        socket.on('typing', (isTyping) => {
            document.getElementById('typingIndicator').style.display = isTyping ? 'block' : 'none';
        });

        socket.on('search_results', (data) => {
            hideLoading('search');
            if (data.success) {
                addMessage('🔍 Search Results for: "' + data.query + '"', 'success', null, 'searchArea');
                data.results.forEach((result, index) => {
                    let resultHtml = '<div class="search-result">';
                    resultHtml += '<strong>' + (index + 1) + '. ' + (result.title || 'Search Result') + '</strong><br>';
                    if (result.url) {
                        resultHtml += '<a href="' + result.url + '" target="_blank" style="color: #007bff; text-decoration: none;">🔗 ' + result.url + '</a><br>';
                    }
                    if (result.snippet) {
                        resultHtml += '<p style="margin-top: 8px;">' + result.snippet + '</p>';
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
                        resultHtml += '<div style="margin-top: 10px; padding: 10px; background: #f8f9fa; border-radius: 5px;">';
                        resultHtml += '<strong>📊 Analysis:</strong><br>' + result.analysis.analysis;
                        resultHtml += '</div>';
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

        socket.on('business_profile_results', (data) => {
            hideLoading('search');
            if (data.success) {
                addMessage('🏢 Enhanced Business Directory Results for: "' + data.query + '"', 'success', null, 'searchArea');
                addMessage('📊 Found ' + data.total_results + ' results from: ' + (data.sources?.join(', ') || 'multiple sources'), 'info', null, 'searchArea');
                
                data.results.forEach((result, index) => {
                    let resultHtml = '<div class="business-profile">';
                    resultHtml += '<strong>' + (index + 1) + '. ' + result.name + '</strong>';
                    resultHtml += ' <span style="font-size: 0.8em; color: #666; background: #e3f2fd; padding: 2px 6px; border-radius: 10px;">' + result.source + '</span><br>';
                    resultHtml += '<strong>📍 Address:</strong> ' + (result.formatted_address || 'Not specified') + '<br>';
                    
                    if (result.street) {
                        resultHtml += '<strong>🏠 Street:</strong> ' + result.street + '<br>';
                    }
                    if (result.city) {
                        resultHtml += '<strong>🏙️ City:</strong> ' + result.city + '<br>';
                    }
                    if (result.state) {
                        resultHtml += '<strong>🗺️ State:</strong> ' + result.state + '<br>';
                    }
                    if (result.country) {
                        resultHtml += '<strong>🌍 Country:</strong> ' + result.country + '<br>';
                    }
                    if (result.phone) {
                        resultHtml += '<strong>📞 Phone:</strong> ' + result.phone + '<br>';
                    }
                    if (result.website) {
                        resultHtml += '<strong>🔗 Website:</strong> <a href="' + result.website + '" target="_blank">' + result.website + '</a><br>';
                    }
                    if (result.email) {
                        resultHtml += '<strong>📧 Email:</strong> ' + result.email + '<br>';
                    }
                    if (result.rating) {
                        resultHtml += '<strong>⭐ Rating:</strong> ' + result.rating + '/5';
                        if (result.total_ratings) {
                            resultHtml += ' (' + result.total_ratings + ' reviews)';
                        }
                        resultHtml += '<br>';
                    }
                    if (result.type) {
                        resultHtml += '<strong>🏷️ Type:</strong> ' + result.type + '<br>';
                    }
                    
                    resultHtml += '<strong>🎯 Confidence:</strong> ' + Math.round((result.confidence || 0.5) * 100) + '%<br>';
                    resultHtml += '</div>';
                    addMessage(resultHtml, 'ai', null, 'searchArea');
                });
            } else {
                addMessage('❌ Business profile search failed: ' + data.error, 'error', null, 'searchArea');
            }
        });

        socket.on('error', (error) => {
            hideLoading('search');
            document.getElementById('typingIndicator').style.display = 'none';
            addMessage('❌ Error: ' + error, 'error', null, 'chatArea');
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
            
            document.getElementById('typingIndicator').style.display = 'block';

            socket.emit('unified_chat', {
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

        function businessProfileSearch() {
            const query = document.getElementById('searchQuery').value.trim();
            
            if (!query) return alert('Please enter a business name or address');

            showLoading('search');
            socket.emit('business_profile_search', { 
                query: query
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

// ========== API ROUTES ==========
app.post('/api/unified-chat', async (req, res) => {
    try {
        const { message, model = defaultModel, sessionId = 'default' } = req.body;
        
        if (!message) {
            return res.json({ error: 'Message is required' });
        }

        const result = await processUnifiedChat(message, model, sessionId);
        res.json(result);

    } catch (error) {
        console.error('Unified chat API error:', error.message);
        res.json({
            success: false,
            error: 'Chat processing failed: ' + error.message
        });
    }
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

// Additional API routes remain the same...
app.post('/api/chat', async (req, res) => {
    try {
        const { message, model = defaultModel, sessionId = 'default' } = req.body;
        
        if (!message) {
            return res.json({ error: 'Message is required' });
        }

        const result = await processUnifiedChat(message, model, sessionId);
        res.json(result);

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
        const { url, model = defaultModel } = req.body;
        
        if (!url) {
            return res.json({ error: 'URL is required' });
        }

        const websiteData = await analyzeWebsiteWithAI(url, model);
        res.json(websiteData);

    } catch (error) {
        res.json({
            success: false,
            error: 'Website analysis failed: ' + error.message
        });
    }
});

app.post('/api/quick-analysis', async (req, res) => {
    try {
        const { url, model = defaultModel } = req.body;
        
        if (!url) {
            return res.json({ error: 'URL is required' });
        }

        const websiteData = await analyzeWebsiteWithAI(url, model);
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

        const websiteData = await analyzeWebsiteWithAI(url, model);
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

app.post('/api/location-search', async (req, res) => {
    try {
        const { query, service = 'openstreetmap' } = req.body;
        
        if (!query) {
            return res.json({ error: 'Location query is required' });
        }

        const locationData = await getLocationData(query, service);
        res.json(locationData);

    } catch (error) {
        res.json({
            success: false,
            error: 'Location search failed: ' + error.message
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
        business_sources: {
            openstreetmap: true,
            wikidata: true,
            opencage: !!OPENCAGE_API_KEY,
            google_places: !!GOOGLE_API_KEY
        },
        search_providers: {
            google_cse: !!GOOGLE_CSE_ID,
            serpapi: !!SERPAPI_KEY,
            ai_fallback: true
        },
        features: [
            'enhanced_business_directory',
            'ai_chat', 
            'website_analysis',
            'business_reports', 
            'web_search', 
            'search_and_analyze', 
            'openstreetmap_maps'
        ]
    });
});

// ========== SOCKET.IO HANDLERS ==========
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('unified_chat', async (data) => {
        try {
            const { message, model, sessionId } = data;
            
            socket.emit('typing', true);

            const response = await axios.post(`http://localhost:${PORT}/api/unified-chat`, {
                message: message,
                model: model || defaultModel,
                sessionId: sessionId
            });

            socket.emit('unified_chat_response', response.data);
        } catch (error) {
            console.error('Socket unified chat error:', error.message);
            socket.emit('error', 'Failed to process message: ' + error.message);
        } finally {
            socket.emit('typing', false);
        }
    });

    // Enhanced Business Profile Search
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

    socket.on('perform_search', async (data) => {
        try {
            const { query, model } = data;
            const searchResults = await performWebSearch(query);
            socket.emit('search_results', {
                ...searchResults,
                query: query
            });
        } catch (error) {
            console.error('Socket search error:', error.message);
            socket.emit('search_results', {
                success: false,
                error: 'Search failed: ' + error.message,
                query: data.query
            });
        }
    });

    socket.on('search_and_analyze', async (data) => {
        try {
            const { query, model } = data;
            const results = await searchAndAnalyze(query, model || defaultModel);
            socket.emit('search_analysis_results', results);
        } catch (error) {
            console.error('Socket search analysis error:', error.message);
            socket.emit('search_analysis_results', {
                success: false,
                error: 'Search and analysis failed: ' + error.message
            });
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
        console.log('🚀 ENHANCED AI Business Directory App Started!');
        console.log('📍 http://localhost:' + PORT);
        console.log('📊 Features: Enhanced Business Directory + AI Analysis');
        console.log('🏢 Business Sources:');
        console.log('   ✅ OpenStreetMap (Free) - Millions of businesses worldwide');
        console.log('   ✅ Wikidata (Free) - Wikipedia business entities');
        console.log('   ' + (OPENCAGE_API_KEY ? '✅' : '❌') + ' OpenCage - ' + (OPENCAGE_API_KEY ? 'Configured' : 'Not configured - Add OPENCAGE_API_KEY to .env'));
        console.log('   ' + (GOOGLE_API_KEY ? '✅' : '❌') + ' Google Places - ' + (GOOGLE_API_KEY ? 'Configured' : 'Not configured - Add GOOGLE_API_KEY to .env'));
        console.log('🤖 Available models:', availableModels.length);
        
        console.log('\n💡 Example searches:');
        console.log('   - "business profile Starbucks"');
        console.log('   - "find business Apple Store"');
        console.log('   - "company information McDonald\'s"');
        console.log('   - Use the Web Search tab → Business Profile button');
    });
});