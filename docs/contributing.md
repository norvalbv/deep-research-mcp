# Contributing

Guidelines for contributing to Research MCP Server.

## Development Setup

### Prerequisites

- Node.js 18+
- TypeScript 5+
- API keys for testing (Gemini, Perplexity)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/research-mcp.git
cd research-mcp

# Install dependencies
npm install

# Build TypeScript
npm run build
```

### Running Locally

```bash
# Development mode (with watch)
npm run dev

# Build for production
npm run build
```

## Running Tests

### Golden Test Cases

The PVR verification system uses golden test cases:

```bash
# Run all tests (requires API key)
GEMINI_API_KEY=your-key RUN_LIVE_TESTS=true npx tsx src/__tests__/pvr-verification.test.ts

# Run offline validation only
npx tsx src/__tests__/pvr-verification.test.ts
```

### Adding Test Cases

Add new cases to `src/__tests__/golden-cases.json`:

```json
{
  "id": "my-test-case",
  "description": "What this tests",
  "category": "contradiction|consistency|edge-case",
  "sections": {
    "overview": "Main section content",
    "q1": "Sub-question content"
  },
  "expected": {
    "isConsistent": true,
    "entailmentScoreMin": 0.85
  }
}
```

Categories:
- `contradiction` - Should detect inconsistency
- `consistency` - Should pass verification
- `edge-case` - Boundary conditions

## Code Style Guidelines

### General

- No emojis in code or documentation
- Professional, technical tone throughout
- All claims cite research papers where applicable

### TypeScript

```typescript
// Use explicit types
function extractClaims(synthesis: SynthesisOutput): Promise<string[]>

// Document complex functions
/**
 * Run PVR verification on synthesis output
 * Based on arxiv:2310.03025
 * 
 * @param synthesis - Structured synthesis output
 * @param manifest - Global constraint manifest
 * @returns Verification result with entailment score
 */
export async function runPVRVerification(...)

// Use const for configuration
const PVR_CONFIG = {
  ENTAILMENT_THRESHOLD: 0.85,  // arxiv:2310.03025
} as const;

// Error handling with context
try {
  const result = await callLLM(prompt, config);
} catch (error) {
  console.error('[PVR] NLI check failed:', error);
  return { score: 1.0, contradictions: [] };  // Fail-open
}
```

### Logging

Use stderr with prefixes:

```typescript
console.error('[Component] Action description...');
console.error('[PVR] Score: 0.92, Consistent: true');
```

Standard prefixes:
- `[Research]` - Controller
- `[Exec]` - Execution
- `[Manifest]` - Manifest extraction
- `[Synthesis]` - Synthesis
- `[PVR]` - Verification
- `[Challenge]` - Challenge
- `[Vote]` - Voting

### Documentation

```markdown
# Section Title

Brief description of what this covers.

## Subsection

- Use tables for configuration options
- Include code examples that are copy-pasteable
- Avoid marketing language ("blazing fast", "revolutionary")

**Research basis:** arxiv:XXXX.XXXXX
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make changes following code style guidelines
4. Add tests if adding new functionality
5. Update documentation if changing behavior
6. Submit pull request with clear description

### PR Checklist

- [ ] Code follows style guidelines
- [ ] Tests pass (or new tests added)
- [ ] Documentation updated
- [ ] No console.log (use console.error for MCP)
- [ ] Thresholds cite research papers

## Research-Backed Changes

When adding or modifying thresholds:

1. Cite the research paper (arxiv ID)
2. Document in code comments
3. Update docs/configuration.md
4. Add to golden test cases if testable

Example:

```typescript
// Use 0.85 threshold per arxiv:2310.03025
const ENTAILMENT_THRESHOLD = 0.85;
```

## Architecture Changes

For significant changes:

1. Update docs/architecture.md
2. Update README.md flow diagram
3. Consider backwards compatibility
4. Document migration path if breaking

## Common Tasks

### Adding a New LLM Provider

1. Add provider config to `src/clients/llm.ts`
2. Add to voting configs if used for consensus
3. Update docs/configuration.md

### Adding a New Validation Step

1. Add to `src/validation.ts`
2. Integrate in `src/controller.ts`
3. Add golden test cases
4. Update docs/architecture.md

### Modifying PVR Thresholds

1. Update `PVR_CONFIG` in `src/validation.ts`
2. Cite research paper for new value
3. Update docs/configuration.md
4. Run golden tests to verify

## Questions?

Open an issue for:
- Feature requests
- Bug reports
- Documentation improvements
- Research suggestions


