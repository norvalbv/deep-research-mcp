# Configuration

Operator guide for configuring Research MCP Server.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google AI (Gemini) API key for planning, synthesis, and validation |
| `PERPLEXITY_API_KEY` | Perplexity API key for web search |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key for multi-model consensus | - |
| `CONTEXT7_API_KEY` | Context7 API key for library documentation | - |
| `ARXIV_STORAGE_PATH` | Path for arXiv paper storage | `~/.arxiv-mcp` |
| `UV_BINARY_PATH` | Explicit path to `uv` binary (for isolated environments) | Auto-discovered |

## MCP Configuration

Add to your MCP client configuration:

**Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Cursor:** `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "research": {
      "command": "node",
      "args": ["/path/to/deep-research-mcp/dist/index.js"],
      "env": {
        "PERPLEXITY_API_KEY": "your-key",
        "GEMINI_API_KEY": "your-key",
        "OPENAI_API_KEY": "your-key",
        "ARXIV_STORAGE_PATH": "/path/to/storage/",
        "UV_BINARY_PATH": "/opt/homebrew/bin/uv"
      }
    }
  }
}
```

**Note on UV_BINARY_PATH**: Required in isolated environments (e.g., Antigravity, CI/CD) where PATH is restricted. The server automatically checks common installation paths (`/opt/homebrew/bin/uv`, `/usr/local/bin/uv`, `~/.local/bin/uv`, `~/.cargo/bin/uv`) if not set. Set this explicitly if `uv` is not in your PATH.

## PVR Configuration

The PVR (Parallel-Verify-Resolve) system uses research-backed thresholds:

| Parameter | Value | Source | Tuning Notes |
|-----------|-------|--------|--------------|
| Entailment threshold | 0.85 | arxiv:2310.03025 | Lower to 0.75 if too aggressive |
| Verification timeout | 5000ms | Industry standard | Increase for slow networks |
| Max re-roll attempts | 2 | Prevent loops | Rarely needs adjustment |
| Min claims for check | 2 | Logic | Must have 2+ claims to compare |

### Adjusting Thresholds

If PVR is flagging too many false positives (minor wording differences as contradictions):

1. The default 0.85 threshold is research-optimal
2. Consider lowering to 0.75 only if you see excessive re-rolls
3. Monitor `[PVR] Score:` logs to understand current behavior

Thresholds are defined in `src/validation.ts`:

```typescript
const PVR_CONFIG = {
  ENTAILMENT_THRESHOLD: 0.85,
  VERIFICATION_TIMEOUT_MS: 5000,
  MAX_REROLL_ATTEMPTS: 2,
  MIN_CLAIMS_FOR_CHECK: 2,
};
```

## Depth Levels

Research depth affects which tools are used:

| Level | Tools Used | Typical Duration |
|-------|------------|------------------|
| 1 | Web search only | ~30s |
| 2 | Web + library docs | ~60s |
| 3 | Web + docs + arXiv | ~90s |
| 4 | All + multi-model consensus | ~2min |
| 5 | All + deep analysis + full validation | ~3min |

Depth is auto-detected based on query complexity, or can be set explicitly:

```json
{
  "query": "How do transformers work?",
  "depth_level": 3
}
```

## Rate Limiting

The server implements rate limit management:

- **Parallel LLM calls**: Capped at 50% of tier limit
- **arXiv API**: 3 requests per second
- **Perplexity API**: Follows API tier limits

If you encounter 429 errors:

1. Check your API tier limits
2. Reduce concurrency in `src/clients/llm.ts`
3. Add delays between requests

## Logging

The server logs to stderr for MCP compatibility:

```
[Research] Initializing...
[Research] Plan: 3/5, perplexity_search, arxiv_search, library_docs
[Exec] Phase 1: Gathering data in parallel...
[Manifest] Extracted 5 facts, 3 numerics
[Synthesis] Using phased approach (token-efficient)...
[PVR] Score: 0.92, Consistent: true, Time: 4521ms
[Research] Running challenge + consensus in parallel...
```

Log prefixes:
- `[Research]` - Controller-level operations
- `[Exec]` - Execution phase
- `[Manifest]` - Global constraint extraction
- `[Synthesis]` - Synthesis operations
- `[PVR]` - Consistency verification
- `[Challenge]` - Critical challenge
- `[Vote]` - Sufficiency voting

## Troubleshooting

### PVR verification always passes

If entailment score is always 1.0:
- Check that sub-questions are being generated
- Verify GEMINI_API_KEY is set
- Look for `[PVR] Insufficient sections` in logs

### Synthesis contradicts itself

If you see contradictions despite PVR:
1. Check that manifest extraction succeeded
2. Verify claims are being extracted (look for claim counts in logs)
3. Consider lowering the entailment threshold

### Slow research times

If research takes > 3 minutes:
1. Check network latency to API endpoints
2. Reduce depth level for faster results
3. Limit sub-questions to 2-3 maximum

### arXiv papers irrelevant

If arXiv returns off-topic papers:
1. The keyword extraction uses Gemini - ensure API key is set
2. Check `[arXiv] Keywords:` in logs for extracted terms
3. Category filtering targets CS/AI/ML by default

### arXiv MCP Server Initialization Failures (EOF errors)

If you see `Error: calling "initialize": EOF` in isolated environments (Antigravity, CI/CD):

**Root cause**: The server cannot find the `uv` binary because PATH is restricted to `/usr/bin:/bin`.

**Solutions**:

1. **Set UV_BINARY_PATH** (Recommended):
```json
{
  "env": {
    "UV_BINARY_PATH": "/opt/homebrew/bin/uv"  // Apple Silicon
    // or "/usr/local/bin/uv" for Intel Mac / Linux
  }
}
```

2. **Verify uv installation**:
```bash
# Check if uv exists at common paths
ls -la /opt/homebrew/bin/uv
ls -la /usr/local/bin/uv
ls -la ~/.local/bin/uv

# Install if missing
curl -LsSf https://astral.sh/uv/install.sh | sh
```

3. **Lazy initialization**: The server now only creates the arXiv client when `read_paper` or `download_paper` tools are called, preventing initialization failures. The server will initialize successfully even if arXiv tools are unavailable.

## Performance Tuning

### For faster results

```json
{
  "depth_level": 2,
  "sub_questions": []
}
```

### For higher quality

```json
{
  "depth_level": 3,
  "include_code_examples": true,
  "output_format": "actionable_steps"
}
```

### For complex research

```json
{
  "depth_level": 4,
  "sub_questions": ["Q1", "Q2", "Q3"],
  "tech_stack": ["python", "langchain"],
  "constraints": ["20 hour budget", "Solo developer"]
}
```


