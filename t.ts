import { setTimeout } from 'timers/promises';
import { randomUUID } from 'crypto';

// --- Logging Configuration ---
// In a real MCP environment, this would integrate with a centralized logging service.
const log = {
    info: (message: string, meta?: Record<string, any>) => console.log(JSON.stringify({ level: 'info', message, ...meta })),
    warn: (message: string, meta?: Record<string, any>) => console.warn(JSON.stringify({ level: 'warn', message, ...meta })),
    error: (message: string, meta?: Record<string, any>) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
    debug: (message: string, meta?: Record<string, any>) => console.debug(JSON.stringify({ level: 'debug', message, ...meta })),
};

// --- Error Types ---
class RateLimitError extends Error {
    constructor(message: string = "Rate limit exceeded") {
        super(message);
        this.name = "RateLimitError";
    }
}

class ApiError extends Error {
    constructor(message: string = "API error occurred") {
        super(message);
        this.name = "ApiError";
    }
}

// --- LLM Client Interface ---
export interface LLMClient {
    /**
     * Sends a prompt to the LLM and returns the generated text.
     * @param prompt The input prompt for the LLM.
     * @param options Optional parameters for the LLM call.
     * @returns A Promise resolving to the LLM's response.
     */
    generateText(prompt: string, options?: LLMCallOptions): Promise<string>;
}

export interface LLMCallOptions {
    /** Maximum number of tokens to generate. */
    maxTokens?: number;
    /** Temperature for sampling. */
    temperature?: number;
    /** Model to use. */
    model?: string;
}

// --- Mock LLM Client Implementation ---
export class MockLLMClient implements LLMClient {
    private readonly modelName: string;
    private readonly maxRetries: number;
    private readonly retryDelayBaseMs: number;
    private readonly simulationLatencyMs: number;
    private readonly rateLimitThreshold: number; // Simulate rate limiting after this many calls within a short window.
    private callCount: number = 0;
    private callTimestamps: number[] = [];

    constructor(
        modelName: string = "mock-reasoning-model",
        maxRetries: number = 3,
        retryDelayBaseMs: number = 1000,
        simulationLatencyMs: number = 500,
        rateLimitThreshold: number = 10
    ) {
        this.modelName = modelName;
        this.maxRetries = maxRetries;
        this.retryDelayBaseMs = retryDelayBaseMs;
        this.simulationLatencyMs = simulationLatencyMs;
        this.rateLimitThreshold = rateLimitThreshold;
        log.info("MockLLMClient initialized", { modelName, maxRetries, retryDelayBaseMs, simulationLatencyMs, rateLimitThreshold });
    }

    private async simulateApiCall(prompt: string, options?: LLMCallOptions): Promise<string> {
        this.callCount++;
        const now = Date.now();
        this.callTimestamps = this.callTimestamps.filter(ts => now - ts < 5000); // Keep timestamps from the last 5 seconds
        this.callTimestamps.push(now);

        if (this.callCount > this.rateLimitThreshold && this.callTimestamps.length > this.rateLimitThreshold / 2) {
            log.warn("Simulating Rate Limit Error", { prompt: prompt.substring(0, 100) + "...", callCount: this.callCount });
            throw new RateLimitError("Simulated rate limit exceeded");
        }

        await setTimeout(this.simulationLatencyMs + Math.random() * 100); // Add some jitter

        // Simulate different reasoning outputs based on prompt keywords
        if (prompt.includes("Tree-of-Thoughts")) {
            return `[ToT Simulation] Thought 1: Initial idea. Thought 2: Explore alternative. Thought 3: Evaluate branch A. Thought 4: Evaluate branch B. Final Answer: ${this.generateDeterministicAnswer(prompt)}`;
        } else if (prompt.includes("Self-Consistency")) {
            const answers = [
                `[SC Simulation] Path 1: Step A -> Step B -> Final Answer: ${this.generateDeterministicAnswer(prompt)}`,
                `[SC Simulation] Path 2: Step A' -> Step B -> Final Answer: ${this.generateDeterministicAnswer(prompt)}`,
                `[SC Simulation] Path 3: Step A -> Step C -> Final Answer: ${this.generateDeterministicAnswer(prompt)}`
            ];
            return answers[Math.floor(Math.random() * answers.length)];
        } else if (prompt.includes("Graph-of-Thoughts")) {
            return `[GoT Simulation] Node 1 (Initial) -> Edge 1 (Refine) -> Node 2 (Intermediate) -> Edge 2 (Aggregate) -> Final Answer: ${this.generateDeterministicAnswer(prompt)}`;
        } else if (prompt.includes("complex multi-step reasoning")) {
            return `[CoT Simulation] Step 1: Analyze input. Step 2: Break down problem. Step 3: Synthesize findings. Step 4: Formulate conclusion. Final Answer: ${this.generateDeterministicAnswer(prompt)}`;
        } else {
            return `[Basic CoT Simulation] Step 1: Understand prompt. Step 2: Generate response. Final Answer: ${this.generateDeterministicAnswer(prompt)}`;
        }
    }

    // Generates a deterministic-looking answer based on prompt hash for consistency in simulations
    private generateDeterministicAnswer(prompt: string): string {
        const hash = Array.from(prompt).reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const answerIndex = hash % 5; // Cycle through a few possible answers
        const possibleAnswers = [
            "Solution A",
            "Solution B",
            "Solution C",
            "Conclusion X",
            "Result Y"
        ];
        return possibleAnswers[answerIndex];
    }

    private async exponentialBackoffRetry<T>(
        operation: () => Promise<T>,
        maxRetries: number,
        baseDelayMs: number,
        errorType: new (message?: string) => Error
    ): Promise<T> {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const result = await operation();
                if (attempt > 0) {
                    log.info(`Operation succeeded on attempt ${attempt + 1}`);
                }
                return result;
            } catch (error: any) {
                if (error instanceof errorType) {
                    const waitTime = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100; // Exponential backoff with jitter
                    log.warn(`Operation failed: ${error.message}. Retrying in ${waitTime.toFixed(2)}ms (Attempt ${attempt + 1}/${maxRetries})`, { error: error.message, attempt, maxRetries, waitTime });
                    await setTimeout(waitTime);
                } else {
                    log.error(`Operation failed with unexpected error: ${error.message}`, { error: error.message, attempt, maxRetries });
                    throw error; // Re-throw unexpected errors
                }
            }
        }
        log.error(`Operation failed after ${maxRetries} retries.`);
        throw new errorType(`All ${maxRetries} retries failed.`);
    }

    async generateText(prompt: string, options?: LLMCallOptions): Promise<string> {
        const operation = () => this.simulateApiCall(prompt, options);
        return this.exponentialBackoffRetry(
            operation,
            this.maxRetries,
            this.retryDelayBaseMs,
            ApiError // Use ApiError as a general catch-all for retries, but simulate RateLimitError specifically
        );
    }
}

// --- Reasoning Strategy Implementations ---

export interface ReasoningStrategy {
    name: string;
    /**
     * Generates a reasoning chain and final answer for a given query.
     * @param query The research question.
     * @param llmClient The LLM client to use.
     * @param options LLM call options.
     * @returns A Promise resolving to the structured reasoning output.
     */
    execute(query: string, llmClient: LLMClient, options?: LLMCallOptions): Promise<ReasoningOutput>;
}

export interface ReasoningOutput {
    query: string;
    strategy: string;
    reasoningChain: string[]; // Intermediate thoughts/steps
    finalAnswer: string;
    rawResponse: string; // The full, unprocessed LLM response
    cost: number; // Estimated cost in LLM calls
    accuracy: number; // Simulated accuracy score (for evaluation purposes)
}

// --- Basic Chain-of-Thought (CoT) ---
export class CoTStrategy implements ReasoningStrategy {
    name = "CoT";
    private readonly maxTokens: number;

    constructor(maxTokens: number = 512) {
        this.maxTokens = maxTokens;
    }

    async execute(query: string, llmClient: LLMClient, options?: LLMCallOptions): Promise<ReasoningOutput> {
        const prompt = `Please provide a step-by-step reasoning process to answer the following research question: "${query}"\n\nChain-of-Thought:`;
        log.info("Executing CoT strategy", { query: query.substring(0, 100) + "..." });

        try {
            const rawResponse = await llmClient.generateText(prompt, { ...options, maxTokens: this.maxTokens });
            const { reasoningChain, finalAnswer } = this.parseCoTResponse(rawResponse);
            // Simulate accuracy: Basic CoT is less accurate for complex tasks
            const simulatedAccuracy = 0.75 + Math.random() * 0.1; // 75-85%
            return {
                query,
                strategy: this.name,
                reasoningChain,
                finalAnswer,
                rawResponse,
                cost: 1, // 1 LLM call
                accuracy: simulatedAccuracy
            };
        } catch (error: any) {
            log.error("CoT execution failed", { query: query.substring(0, 100) + "...", error: error.message });
            throw error;
        }
    }

    private parseCoTResponse(response: string): { reasoningChain: string[]; finalAnswer: string } {
        const lines = response.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        const reasoningChain: string[] = [];
        let finalAnswer = "Could not determine final answer.";

        for (const line of lines) {
            if (line.startsWith("Final Answer:")) {
                finalAnswer = line.replace("Final Answer:", "").trim();
            } else if (line.startsWith("Thought") || line.startsWith("Step")) {
                reasoningChain.push(line);
            } else if (line.startsWith("[Basic CoT Simulation]")) {
                 // Handle mock specific prefixes
                 if (line.includes("Final Answer:")) {
                    finalAnswer = line.split("Final Answer:")[[arxiv.org]](https://arxiv.org/html/2502.03671v1).trim();
                 } else {
                    reasoningChain.push(line);
                 }
            } else {
                // If it's not a clear step or final answer, assume it's part of the chain if it's not the very first line
                if (reasoningChain.length > 0 || lines.indexOf(line) > 0) {
                    reasoningChain.push(line);
                }
            }
        }
        // If no explicit "Final Answer:" found, take the last line as a fallback
        if (finalAnswer === "Could not determine final answer." && lines.length > 0) {
            finalAnswer = lines[lines.length - 1];
        }
        return { reasoningChain, finalAnswer };
    }
}

// --- Self-Consistency Strategy ---
export class SelfConsistencyStrategy implements ReasoningStrategy {
    name = "Self-Consistency";
    private readonly numSamples: number;
    private readonly maxTokens: number;

    constructor(numSamples: number = 5, maxTokens: number = 512) {
        this.numSamples = numSamples;
        this.maxTokens = maxTokens;
    }

    async execute(query: string, llmClient: LLMClient, options?: LLMCallOptions): Promise<ReasoningOutput> {
        const basePrompt = `Please provide a step-by-step reasoning process to answer the following research question: "${query}"\n\nChain-of-Thought:`;
        log.info("Executing Self-Consistency strategy", { query: query.substring(0, 100) + "...", numSamples: this.numSamples });

        const responses: string[] = [];
        const reasoningChains: string[][] = [];
        const finalAnswers: string[] = [];

        for (let i = 0; i < this.numSamples; i++) {
            const prompt = `${basePrompt} (Sample ${i + 1})`; // Differentiate samples slightly if needed by model
            try {
                const rawResponse = await llmClient.generateText(prompt, { ...options, maxTokens: this.maxTokens });
                responses.push(rawResponse);
                const { reasoningChain, finalAnswer } = new CoTStrategy().parseCoTResponse(rawResponse); // Reuse CoT parser
                reasoningChains.push(reasoningChain);
                finalAnswers.push(finalAnswer);
            } catch (error: any) {
                log.warn("Self-Consistency sample generation failed", { query: query.substring(0, 100) + "...", sample: i + 1, error: error.message });
                // Continue with other samples, but note the failure
            }
        }

        if (finalAnswers.length === 0) {
            throw new ApiError("All Self-Consistency samples failed.");
        }

        // Majority vote for the final answer
        const answerCounts = finalAnswers.reduce((acc, answer) => {
            acc[answer] = (acc[answer] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        let bestAnswer = finalAnswers[0];
        let maxCount = 0;
        for (const answer in answerCounts) {
            if (answerCounts[answer] > maxCount) {
                maxCount = answerCounts[answer];
                bestAnswer = answer;
            }
        }

        // Simulate accuracy: Self-Consistency improves accuracy
        const simulatedAccuracy = 0.85 + Math.random() * 0.1; // 85-95%
        return {
            query,
            strategy: this.name,
            reasoningChain: reasoningChains[finalAnswers.indexOf(bestAnswer)], // Use chain from one of the majority answers
            finalAnswer: bestAnswer,
            rawResponse: responses.join("\n---\n"), // Concatenate responses for inspection
            cost: this.numSamples, // Number of LLM calls
            accuracy: simulatedAccuracy
        };
    }
}

// --- Tree-of-Thoughts (ToT) - Simplified Exploration ---
// This is a simplified simulation of ToT's exploration. A full implementation
// would involve a search algorithm (BFS/DFS) and a value/policy function.
export class TreeOfThoughtsStrategy implements ReasoningStrategy {
    name = "Tree-of-Thoughts";
    private readonly maxDepth: number;
    private readonly branchingFactor: number;
    private readonly maxTokens: number;

    constructor(maxDepth: number = 3, branchingFactor: number = 2, maxTokens: number = 256) {
        this.maxDepth = maxDepth;
        this.branchingFactor = branchingFactor;
        this.maxTokens = maxTokens;
    }

    async execute(query: string, llmClient: LLMClient, options?: LLMCallOptions): Promise<ReasoningOutput> {
        log.info("Executing Tree-of-Thoughts strategy", { query: query.substring(0, 100) + "...", maxDepth: this.maxDepth, branchingFactor: this.branchingFactor });

        // Simulate ToT exploration: Generate multiple paths and pick the "best" based on a heuristic
        const simulatedPaths: { chain: string[]; answer: string; raw: string }[] = [];
        let totalCost = 0;

        // Simulate root thought
        const rootPrompt = `[ToT Root] Consider the research question: "${query}". What is the first step or thought?`;
        try {
            const rootResponse = await llmClient.generateText(rootPrompt, { ...options, maxTokens: this.maxTokens });
            totalCost++;
            const { reasoningChain: rootChain, finalAnswer: rootAnswer } = new CoTStrategy().parseCoTResponse(rootResponse);
            simulatedPaths.push({ chain: rootChain, answer: rootAnswer, raw: rootResponse });
        } catch (error: any) {
            log.error("ToT root generation failed", { query: query.substring(0, 100) + "...", error: error.message });
            throw error;
        }

        // Simulate branching and exploration
        for (let d = 0; d < this.maxDepth; d++) {
            const nextPaths: { chain: string[]; answer: string; raw: string }[] = [];
            for (const path of simulatedPaths) {
                if (path.chain.length > 0 && !path.chain[path.chain.length - 1].includes("Final Answer:")) {
                    for (let b = 0; b < this.branchingFactor; b++) {
                        const branchPrompt = `[ToT Branch ${d + 1}.${b + 1}] Given the previous thoughts: "${path.chain.join('; ')}". What is the next logical step or alternative thought?`;
                        try {
                            const branchResponse = await llmClient.generateText(branchPrompt, { ...options, maxTokens: this.maxTokens });
                            totalCost++;
                            const { reasoningChain: branchChain, finalAnswer: branchAnswer } = new CoTStrategy().parseCoTResponse(branchResponse);
                            // Combine parent chain with new branch
                            const newChain = [...path.chain, ...branchChain];
                            nextPaths.push({ chain: newChain, answer: branchAnswer, raw: branchResponse });
                        } catch (error: any) {
                            log.warn("ToT branch generation failed", { query: query.substring(0, 100) + "...", depth: d, branch: b, error: error.message });
                        }
                    }
                }
            }
            // Replace current paths with newly generated ones, keeping only the "best" if needed (simplified here)
            if (nextPaths.length > 0) {
                simulatedPaths.splice(0, simulatedPaths.length, ...nextPaths);
            }
        }

        // Select the "best" final answer from explored paths (simplified: pick one with "Final Answer:")
        let bestAnswer = "Could not determine final answer.";
        let bestChain: string[] = [];
        let bestRawResponse = "";

        for (const path of simulatedPaths) {
            if (path.answer.includes("Final Answer:")) {
                bestAnswer = path.answer;
                bestChain = path.chain;
                bestRawResponse = path.raw;
                break; // Found a potential final answer
            }
        }
        // Fallback if no explicit "Final Answer:" found
        if (bestAnswer === "Could not determine final answer." && simulatedPaths.length > 0) {
            bestAnswer = simulatedPaths[0].answer;
            bestChain = simulatedPaths[0].chain;
            bestRawResponse = simulatedPaths[0].raw;
        }

        // Simulate accuracy: ToT is generally more accurate but complex
        const simulatedAccuracy = 0.90 + Math.random() * 0.05; // 90-95%
        return {
            query,
            strategy: this.name,
            reasoningChain: bestChain,
            finalAnswer: bestAnswer,
            rawResponse: simulatedPaths.map(p => p.raw).join("\n---\n"),
            cost: totalCost,
            accuracy: simulatedAccuracy
        };
    }
}

// --- Graph-of-Thoughts (GoT) - Conceptual Simulation ---
// A full GoT implementation would involve graph data structures and traversal algorithms.
// This simulation focuses on the idea of interconnected thoughts and refinement.
export class GraphOfThoughtsStrategy implements ReasoningStrategy {
    name = "Graph-of-Thoughts";
    private readonly maxNodes: number;
    private readonly maxEdgesPerNode: number;
    private readonly maxTokens: number;

    constructor(maxNodes: number = 5, maxEdgesPerNode: number = 2, maxTokens: number = 256) {
        this.maxNodes = maxNodes;
        this.maxEdgesPerNode = maxEdgesPerNode;
        this.maxTokens = maxTokens;
    }

    async execute(query: string, llmClient: LLMClient, options?: LLMCallOptions): Promise<ReasoningOutput> {
        log.info("Executing Graph-of-Thoughts strategy (simulated)", { query: query.substring(0, 100) + "...", maxNodes: this.maxNodes, maxEdgesPerNode: this.maxEdgesPerNode });

        let currentNodeId = 0;
        const graph: Record<number, { thought: string; edges: { targetNodeId: number; operation: string }[] }> = {};
        let totalCost = 0;

        // Simulate initial node
        const initialPrompt = `[GoT Initial Node] For the research question: "${query}", what is the initial core concept or thought?`;
        try {
            const initialResponse = await llmClient.generateText(initialPrompt, { ...options, maxTokens: this.maxTokens });
            totalCost++;
            const { reasoningChain: initialChain, finalAnswer: initialAnswer } = new CoTStrategy().parseCoTResponse(initialResponse);
            graph[currentNodeId] = { thought: initialChain.join('; '), edges: [] };
            if (initialAnswer.includes("Final Answer:")) {
                // If initial response already contains final answer, we are done.
                return {
                    query,
                    strategy: this.name,
                    reasoningChain: [initialChain.join('; ')],
                    finalAnswer: initialAnswer,
                    rawResponse: initialResponse,
                    cost: totalCost,
                    accuracy: 0.88 + Math.random() * 0.05 // Simulated accuracy
                };
            }
        } catch (error: any) {
            log.error("GoT initial node generation failed", { query: query.substring(0, 100) + "...", error: error.message });
            throw error;
        }

        // Simulate graph expansion
        for (let i = 0; i < this.maxNodes && Object.keys(graph).length < this.maxNodes; i++) {
            const currentNode = graph[i];
            if (!currentNode) continue;

            for (let e = 0; e < this.maxEdgesPerNode && currentNode.edges.length < this.maxEdgesPerNode; e++) {
                const nextNodeId = Object.keys(graph).length;
                if (nextNodeId >= this.maxNodes) break;

                const operationPrompt = `[GoT Operation] Given the thought "${currentNode.thought}", what is a relevant operation (e.g., 'refine', 'aggregate', 'contrast', 'hypothesize') and the resulting new thought?`;
                try {
                    const operationResponse = await llmClient.generateText(operationPrompt, { ...options, maxTokens: this.maxTokens });
                    totalCost++;
                    const { reasoningChain: operationChain, finalAnswer: operationAnswer } = new CoTStrategy().parseCoTResponse(operationResponse);

                    // Parse operation and new thought from response
                    let operation = "unknown operation";
                    let newThought = operationChain.join('; ');
                    if (operationChain.length > 0) {
                        const firstLine = operationChain[0];
                        if (firstLine.includes("operation:")) {
                            operation = firstLine.split("operation:")[[arxiv.org]](https://arxiv.org/html/2502.03671v1).trim();
                            newThought = operationChain.slice(1).join('; ');
                        } else if (firstLine.includes("->")) {
                            const parts = firstLine.split("->");
                            operation = parts[0].trim();
                            newThought = parts[[arxiv.org]](https://arxiv.org/html/2502.03671v1).trim();
                        }
                    }
                    if (operationAnswer.includes("Final Answer:")) {
                        // If a node directly leads to a final answer
                        return {
                            query,
                            strategy: this.name,
                            reasoningChain: [...Object.values(graph).map(n => n.thought), newThought],
                            finalAnswer: operationAnswer,
                            rawResponse: Object.values(graph).map(n => n.thought).join("\n") + "\n" + operationResponse,
                            cost: totalCost,
                            accuracy: 0.92 + Math.random() * 0.03 // Simulated accuracy
                        };
                    }

                    graph[nextNodeId] = { thought: newThought, edges: [] };
                    currentNode.edges.push({ targetNodeId: nextNodeId, operation });

                } catch (error: any) {
                    log.warn("GoT operation generation failed", { query: query.substring(0, 100) + "...", node: i, edge: e, error: error.message });
                }
            }
        }

        // Fallback: If no explicit final answer found, take the last generated thought as a proxy
        let finalAnswer = "Could not determine final answer.";
        let finalChain: string[] = [];
        if (Object.keys(graph).length > 0) {
            const lastNodeId = Math.max(...Object.keys(graph).map(Number));
            finalAnswer = graph[lastNodeId].thought;
            finalChain = Object.values(graph).map(n => n.thought);
        }

        // Simulate accuracy: GoT is complex and potentially highly accurate
        const simulatedAccuracy = 0.92 + Math.random() * 0.03; // 92-95%
        return {
            query,
            strategy: this.name,
            reasoningChain: finalChain,
            finalAnswer: finalAnswer,
            rawResponse: JSON.stringify(graph, null, 2),
            cost: totalCost,
            accuracy: simulatedAccuracy
        };
    }
}

// --- RL-Enhanced CoT / Test-Time Compute Simulation ---
// This simulates the outcome of advanced models by directly generating a high-quality
// reasoning chain and answer, reflecting the benefits of RL/test-time compute.
export class RLEnhancedCoTStrategy implements ReasoningStrategy {
    name = "RL-Enhanced CoT";
    private readonly maxTokens: number;

    constructor(maxTokens: number = 768) { // Higher maxTokens for more complex reasoning
        this.maxTokens = maxTokens;
    }

    async execute(query: string, llmClient: LLMClient, options?: LLMCallOptions): Promise<ReasoningOutput> {
        // Simulate a model that has been fine-tuned with RL or uses test-time compute.
        // This means it directly produces a high-quality, structured reasoning chain.
        const prompt = `[RL-Enhanced CoT] Provide a highly accurate, step-by-step reasoning process for the following complex research question, leveraging advanced reasoning techniques:\n"${query}"\n\nReasoning Process:`;
        log.info("Executing RL-Enhanced CoT strategy", { query: query.substring(0, 100) + "..." });

        try {
            // In a real scenario, this would call a specific model endpoint or use advanced inference parameters.
            // Here, we simulate the output quality.
            const rawResponse = await llmClient.generateText(prompt, { ...options, maxTokens: this.maxTokens });
            const { reasoningChain, finalAnswer } = this.parseRLResponse(rawResponse);

            // Simulate accuracy: RL-Enhanced CoT is state-of-the-art
            const simulatedAccuracy = 0.92 + Math.random() * 0.02; // 92-94%
            return {
                query,
                strategy: this.name,
                reasoningChain,
                finalAnswer,
                rawResponse,
                cost: 1, // Assumes a single, optimized call for this strategy
                accuracy: simulatedAccuracy
            };
        } catch (error: any) {
            log.error("RL-Enhanced CoT execution failed", { query: query.substring(0, 100) + "...", error: error.message });
            throw error;
        }
    }

    private parseRLResponse(response: string): { reasoningChain: string[]; finalAnswer: string } {
        const lines = response.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        const reasoningChain: string[] = [];
        let finalAnswer = "Could not determine final answer.";

        let foundFinalAnswer = false;
        for (const line of lines) {
            if (line.startsWith("Final Answer:")) {
                finalAnswer = line.replace("Final Answer:", "").trim();
                foundFinalAnswer = true;
                // Continue parsing to capture the full chain if it's structured
            } else if (line.startsWith("Step") || line.startsWith("Thought") || line.startsWith("Conclusion") || line.startsWith("Analysis") || line.startsWith("Hypothesis") || line.startsWith("Refinement")) {
                reasoningChain.push(line);
            } else if (line.startsWith("[RL-Enhanced CoT]")) {
                // Handle mock specific prefixes
                if (line.includes("Final Answer:")) {
                    finalAnswer = line.split("Final Answer:")[[arxiv.org]](https://arxiv.org/html/2502.03671v1).trim();
                    foundFinalAnswer = true;
                } else {
                    reasoningChain.push(line);
                }
            } else if (foundFinalAnswer && reasoningChain.length > 0) {
                // If we've already found the final answer, and this line looks like a continuation of the chain
                reasoningChain.push(line);
            } else if (!foundFinalAnswer && reasoningChain.length > 0) {
                // If we haven't found the final answer yet, and this line looks like a step
                reasoningChain.push(line);
            }
        }

        // If no explicit "Final Answer:" found, take the last line as a fallback
        if (!foundFinalAnswer && lines.length > 0) {
            finalAnswer = lines[lines.length - 1];
            // Ensure the last line is also part of the chain if it wasn't captured
            if (!reasoningChain.includes(finalAnswer)) {
                reasoningChain.push(finalAnswer);
            }
        } else if (!foundFinalAnswer && lines.length === 0) {
            return { reasoningChain: [], finalAnswer: "Empty response." };
        }

        return { reasoningChain, finalAnswer };
    }
}


// --- Evaluation and Execution Logic ---

interface EvaluationResult {
    query: string;
    strategy: string;
    reasoningChain: string[];
    finalAnswer: string;
    rawResponse: string;
    cost: number;
    accuracy: number;
    executionTimeMs: number;
}

async function evaluateStrategy(
    strategy: ReasoningStrategy,
    query: string,
    llmClient: LLMClient,
    llmOptions?: LLMCallOptions
): Promise<EvaluationResult> {
    const startTime = Date.now();
    try {
        const output = await strategy.execute(query, llmClient, llmOptions);
        const endTime = Date.now();
        return {
            ...output,
            executionTimeMs: endTime - startTime,
        };
    } catch (error: any) {
        const endTime = Date.now();
        log.error("Strategy evaluation failed", { query: query.substring(0, 100) + "...", strategy: strategy.name, error: error.message });
        return {
            query,
            strategy: strategy.name,
            reasoningChain: [],
            finalAnswer: `Error: ${error.message}`,
            rawResponse: `Error: ${error.message}`,
            cost: 0, // Indicate failure
            accuracy: 0, // Indicate failure
            executionTimeMs: endTime - startTime,
        };
    }
}

async function runTests() {
    const mockLLMClient = new MockLLMClient(
        "mock-reasoning-model",
        3, // maxRetries
        1000, // retryDelayBaseMs
        300, // simulationLatencyMs
        15 // rateLimitThreshold
    );

    const complexResearchQuestion = "Analyze the impact of quantum computing on current cryptographic algorithms and propose potential mitigation strategies for post-quantum cryptography.";
    const simpleQuestion = "What is the capital of France?";

    const strategies: ReasoningStrategy[] = [
        new CoTStrategy(512),
        new SelfConsistencyStrategy(5, 512),
        new TreeOfThoughtsStrategy(3, 2, 256), // Depth 3, Branching Factor 2
        new GraphOfThoughtsStrategy(5, 2, 256), // Max 5 Nodes, Max 2 Edges per Node
        new RLEnhancedCoTStrategy(768)
    ];

    const results: EvaluationResult[] = [];

    for (const strategy of strategies) {
        log.info(`--- Running evaluation for strategy: ${strategy.name} ---`);
        try {
            const evaluationResult = await evaluateStrategy(strategy, complexResearchQuestion, mockLLMClient);
            results.push(evaluationResult);
            log.info(`Evaluation complete for ${strategy.name}`, {
                query: complexResearchQuestion.substring(0, 50) + "...",
                accuracy: evaluationResult.accuracy.toFixed(4),
                cost: evaluationResult.cost,
                timeMs: evaluationResult.executionTimeMs,
                finalAnswer: evaluationResult.finalAnswer.substring(0, 50) + "..."
            });
        } catch (error: any) {
            log.error(`Failed to evaluate strategy ${strategy.name}`, { error: error.message });
        }
    }

    log.info("\n--- Comprehensive Evaluation Summary ---");
    results.forEach(res => {
        console.log(`\nStrategy: ${res.strategy}`);
        console.log(`  Query: ${res.query.substring(0, 80)}...`);
        console.log(`  Final Answer: ${res.finalAnswer}`);
        console.log(`  Accuracy (Simulated): ${res.accuracy.toFixed(4)}`);
        console.log(`  Cost (LLM Calls): ${res.cost}`);
        console.log(`  Execution Time: ${res.executionTimeMs} ms`);
        // console.log(`  Reasoning Chain (first step): ${res.reasoningChain.length > 0 ? res.reasoningChain[0] : 'N/A'}`);
        // console.log(`  Raw Response Snippet: ${res.rawResponse.substring(0, 100)}...`);
    });

    // Example of how to integrate with MCP stack (conceptual)
    // Assuming `mcpService.evaluateResearchQuestion(query, strategyName)` exists
    // async function integrateWithMCP(query: string, strategy: ReasoningStrategy, llmClient: LLMClient) {
    //     const result = await evaluateStrategy(strategy, query, llmClient);
    //     // Assuming MCP has a service to record evaluation results
    //     // await mcpService.recordEvaluationResult({
    //     //     queryId: generateQueryId(), // Function to get a unique query ID
    //     //     strategyUsed: strategy.name,
    //     //     accuracy: result.accuracy,
    //     //     cost: result.cost,
    //     //     executionTimeMs: result.executionTimeMs,
    //     //     reasoningChain: result.reasoningChain,
    //     //     finalAnswer: result.finalAnswer,
    //     //     rawResponse: result.rawResponse,
    //     //     timestamp: new Date().toISOString()
    //     // });
    //     log.info(`[MCP Integration] Recorded evaluation for ${strategy.name}`);
    // }

    // log.info("\n--- Simulating MCP Integration ---");
    // for (const strategy of strategies) {
    //     await integrateWithMCP(complexResearchQuestion, strategy, mockLLMClient);
    // }
}

// Execute the tests
runTests().catch(error => {
    log.error("An unhandled error occurred during test execution.", { error: error.message });
});