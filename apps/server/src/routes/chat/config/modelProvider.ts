/**
 * Model provider setup with mem0
 * 
 * mem0 handles context retrieval via REST API:
 * - Semantic search via mem0's hosted platform
 * - Conversation-level memory scoping
 * - Automatic deduplication and updates
 */

import { anthropic } from '@ai-sdk/anthropic';
import type { UIMessage } from 'ai';
import { estimateTotalTokens } from '../../../lib/contextWindow.js';
import { v4 as uuidv4 } from 'uuid';

interface ModelProviderResult {
  model: any;
  processedMessages: UIMessage[];
  strategy: {
    useExtendedThinking: boolean;
    useMem0: boolean;
    estimatedTokens: number;
    reason: string;
  };
}

// mem0 Platform API Base URL
const MEM0_API_BASE = 'https://api.mem0.ai/v1';

/**
 * mem0 Platform REST API client
 */
class Mem0PlatformClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl: string = MEM0_API_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`mem0 API error (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  async add(messages: string | any[], userId: string, metadata: Record<string, any> = {}): Promise<any> {
    return this.request('/memories/', {
      method: 'POST',
      body: JSON.stringify({
        messages: typeof messages === 'string' ? messages : messages,
        user_id: userId,
        metadata,
      }),
    });
  }

  async search(query: string, userId: string, options: { limit?: number } = {}): Promise<any> {
    const params = new URLSearchParams({
      query,
      user_id: userId,
      limit: (options.limit || 10).toString(),
    });

    return this.request(`/memories/search/?${params.toString()}`);
  }
}

// Initialize mem0 Platform client once at module level
let mem0Client: Mem0PlatformClient | null = null;

export async function getMem0Client(): Promise<Mem0PlatformClient> {
  if (!mem0Client) {
    const mem0ApiKey = process.env.OPENMEMORY_API_KEY;

    if (!mem0ApiKey) {
      throw new Error('OPENMEMORY_API_KEY is required but not configured');
    }

    mem0Client = new Mem0PlatformClient(mem0ApiKey);
    console.log('✨ [mem0] Platform client initialized');
  }

  return mem0Client;
}

/**
 * Store a message to mem0
 * 
 * @param conversationId - Conversation ID (used as userId for conversation-level scoping)
 * @param userId - Actual user ID (stored in metadata)
 * @param role - Message role (user or assistant)
 * @param message - Message object or content string
 * @param messageId - Message ID
 */
export async function storeMessage(
  conversationId: string,
  userId: string,
  role: 'user' | 'assistant',
  message: any,
  messageId: string
): Promise<void> {
  const memory = await getMem0Client();
  
  // Extract text content from message
  let content = '';
  if (typeof message === 'string') {
    content = message;
  } else if (message.content) {
    content = message.content;
  } else if (message.parts && Array.isArray(message.parts)) {
    // Extract text from parts array
    content = message.parts
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('\n');
  }

  if (!content || content.trim().length === 0) {
    console.warn(`⚠️ [mem0] Skipping empty message: ${messageId}`);
    return;
  }

  try {
    // Format as message array for mem0
    const messages = [
      {
        role,
        content
      }
    ];

    // Store using conversationId as userId for conversation-level scoping
    // Actual userId and other metadata stored for reference
    await memory.add(messages, conversationId, {
      role,
      message_id: messageId,
      actual_user_id: userId,
      conversation_id: conversationId,
      created_at: new Date().toISOString()
    });
    
    console.log(`✅ [mem0] Stored ${role} message: ${messageId}`);
  } catch (error) {
    console.error(`❌ [mem0] Failed to store ${role} message:`, error);
    // Don't throw - continue even if memory storage fails
  }
}

/**
 * Search for relevant context from mem0
 * 
 * @param conversationId - Conversation ID (used as userId for scoping)
 * @param query - Search query
 * @param limit - Maximum number of results
 * @returns Array of relevant memories
 */
async function searchContext(
  conversationId: string,
  query: string,
  limit: number = 10
): Promise<any[]> {
  const memory = await getMem0Client();
  
  try {
    // Search using conversationId as userId for conversation-level scoping
    const response = await memory.search(query, conversationId, { limit });
    
    if (response && response.results && Array.isArray(response.results)) {
      console.log(`📝 [mem0] Found ${response.results.length} relevant memories`);
      return response.results;
    }
    
    return [];
  } catch (error) {
    console.error('❌ [mem0] Search failed:', error);
    return [];
  }
}

/**
 * Setup model provider with mem0
 * 
 * Gets relevant context from mem0 and returns Anthropic model
 * 
 * @param messages - Full conversation history (from client)
 * @param conversationId - Conversation ID for memory scoping
 * @param userId - User ID for reference
 * @param claudeModel - Claude model to use
 * @returns Model instance and context-enriched messages
 */
export async function setupModelProvider(
  messages: UIMessage[],
  conversationId: string,
  userId: string,
  claudeModel: string
): Promise<ModelProviderResult> {
  const estimatedTokens = estimateTotalTokens(messages);
  
  console.log(`🧠 [mem0] Full conversation: ${messages.length} messages, ${estimatedTokens.toLocaleString()} tokens`);
  
  // Extract last user message for search query
  const userMessages = messages.filter(msg => msg.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1];
  
  let searchQuery = '';
  if (lastUserMessage) {
    const msg = lastUserMessage as any;
    if (typeof msg.content === 'string') {
      searchQuery = msg.content;
    } else if (msg.parts && Array.isArray(msg.parts)) {
      searchQuery = msg.parts
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join(' ');
    }
  }

  let contextMessages = messages;
  let retrievedCount = 0;
  let usedMem0 = false;

  // Search for relevant context if we have a query
  if (searchQuery && searchQuery.trim().length > 0) {
    try {
      const relevantMemories = await searchContext(conversationId, searchQuery, 10);
      
      if (relevantMemories.length > 0) {
        usedMem0 = true;
        retrievedCount = relevantMemories.length;
        
        // Build historical context from retrieved memories
        const historicalContext = relevantMemories
          .map((mem: any, idx: number) => {
            const score = mem.score ? ` (relevance: ${mem.score.toFixed(2)})` : '';
            return `${idx + 1}. ${mem.memory}${score}`;
          })
          .join('\n\n');
        
        // Inject as context before the recent messages
        const contextMessage: UIMessage = {
          id: uuidv4(),
          role: 'user',
          parts: [{
            type: 'text',
            text: `[CONTEXT FROM PAST MESSAGES IN THIS CONVERSATION]\n${historicalContext}\n\n[END CONTEXT - Continue with current conversation]`,
          }],
        };
        
        // Keep only recent messages to save tokens (last 10)
        const recentCount = Math.min(10, messages.length);
        const recentMessages = messages.slice(-recentCount);
        
        contextMessages = [contextMessage, ...recentMessages];
        
        console.log(`📝 [mem0] Injected ${retrievedCount} memories as context, keeping ${recentCount} recent messages`);
      }
    } catch (error) {
      console.error('❌ [mem0] Failed to retrieve context:', error);
      // Continue with original messages on error
    }
  }

  const finalEstimatedTokens = estimateTotalTokens(contextMessages);
  console.log(`📊 [mem0] Final message count: ${contextMessages.length}, estimated tokens: ${finalEstimatedTokens.toLocaleString()}`);

  // Get the Anthropic model
  const model = anthropic(claudeModel);

  return {
    model,
    processedMessages: contextMessages,
    strategy: {
      useExtendedThinking: false,
      useMem0: usedMem0,
      estimatedTokens: finalEstimatedTokens,
      reason: usedMem0 
        ? `mem0: ${retrievedCount} memories + ${contextMessages.length - 1} recent` 
        : 'mem0: no relevant memories found, using recent messages'
    }
  };
}
