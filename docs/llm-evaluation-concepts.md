# LLM Evaluation Concepts

A reference guide for LLM evaluation techniques used in this project's benchmarking system.

---

## 1. LLM-as-a-Judge

- **What is it?**: A paradigm where one LLM evaluates the outputs of another LLM, replacing or supplementing human evaluation.
- **Introduced**: As a scalable alternative to expensive human annotation for evaluating AI system outputs.
- **Challenge it solved**: Human evaluation doesn't scale. Manual annotation of thousands of responses is slow and costly. LLM judges provide consistent, automated evaluation at scale.
- **File location**: `benchmarks/comparison.ts`, `src/validation.ts`
- **Summary**: Uses a capable LLM (e.g., GPT-4o, Gemini) to score responses on criteria like accuracy, completeness, and reasoning quality. Requires careful prompt design and calibration to align with human judgment.
- **Papers/articles**:
  - arxiv:2306.05685 - Judging LLM-as-a-Judge
  - arxiv:2408.13006v2 - LLM Judge evaluation framework
  - arxiv:2411.15594v6 - Position bias in LLM judges
- **Priority of learning**: 9/10 (foundational to all evaluation work)
- **Complexity score**: 4/10

---

## 2. Symmetric Pairwise Swapping

- **What is it?**: A bias-elimination technique that evaluates response pairs in both orders (A,B) and (B,A), only accepting results when the judge is consistent.
- **Introduced**: To eliminate position bias where judges systematically favor the first or second response regardless of content.
- **Challenge it solved**: Position bias can skew results by up to 35%. Without symmetric swapping, benchmarks may incorrectly declare winners based on placement rather than quality.
- **File location**: `benchmarks/comparison.ts` (after implementation)
- **Summary**: Run each comparison twice with reversed order. If judge picks "Response 1" in both trials, it demonstrates position bias and the result is discarded as an "Inconsistent Tie."
- **Papers/articles**:
  - arxiv:2411.15594v6 - Position bias mitigation strategies
- **Priority of learning**: 9/10 (critical for unbiased benchmarks)
- **Complexity score**: 3/10

---

## 3. Position Consistency (PC)

- **What is it?**: A metric measuring the percentage of comparisons where the judge's preference remained stable despite order swapping.
- **Introduced**: As a quality metric to detect and quantify position bias in LLM judges.
- **Challenge it solved**: Without a metric, you can't know if your judge has position bias until results are already corrupted.
- **File location**: `benchmarks/comparison.ts` (after implementation)
- **Summary**: PC = (consistent results) / (total pairs). Target: PC > 0.90. If PC falls below 0.70, the judge needs recalibration or replacement.
- **Papers/articles**:
  - arxiv:2411.15594v6
- **Priority of learning**: 8/10 (essential diagnostic metric)
- **Complexity score**: 2/10

---

## 4. Rationale-First Prompting (Chain-of-Thought)

- **What is it?**: A prompting strategy that requires the judge to explain reasoning before providing a final score.
- **Introduced**: To reduce anchoring effects where judges make snap decisions based on superficial features.
- **Challenge it solved**: Without explicit reasoning, judges anchor to position, length, or style rather than content quality.
- **File location**: `benchmarks/comparison.ts`, `src/validation.ts`
- **Summary**: Prompt structure forces: (1) List claims/steps in each response, (2) Evaluate against rubric, (3) Provide final score. The reasoning phase anchors the decision in evidence.
- **Papers/articles**:
  - arxiv:2408.13006v2
- **Priority of learning**: 8/10 (significantly improves judge quality)
- **Complexity score**: 3/10

---

## 5. Score-per-Info-Unit (SIU)

- **What is it?**: A length-normalized scoring metric that penalizes verbosity by dividing quality score by log of word count.
- **Introduced**: To mitigate verbosity bias where longer responses unfairly receive higher scores.
- **Challenge it solved**: LLM judges often favor longer responses even when the extra length is "fluff" without substance.
- **File location**: `benchmarks/comparison.ts` (after implementation)
- **Summary**: `SIU = score / ln(wordCount + 1)`. Rewards information density over word count. Used primarily for synthesis tasks.
- **Papers/articles**:
  - arxiv:2408.13006v2
- **Priority of learning**: 7/10 (important for synthesis evaluation)
- **Complexity score**: 4/10

---

## 6. 25/5 Rule

- **What is it?**: A tie-breaking heuristic: if Response A is >25% longer than Response B but only <5% better in quality, treat it as a tie.
- **Introduced**: As a simple guard against verbosity bias without complex calculations.
- **Challenge it solved**: Prevents "word salad" responses from winning purely due to length.
- **File location**: `benchmarks/comparison.ts` (after implementation)
- **Summary**: Quick check before finalizing winner. If length ratio > 1.25 and score ratio < 1.05, result = tie.
- **Papers/articles**:
  - arxiv:2408.13006v2
- **Priority of learning**: 6/10 (useful heuristic)
- **Complexity score**: 2/10

---

## 7. Task-Specific Rubrics

- **What is it?**: Different evaluation criteria optimized for different task types (factual, reasoning, synthesis).
- **Introduced**: Because generic rubrics bias toward certain response styles regardless of task requirements.
- **Challenge it solved**: A synthesis task shouldn't be judged the same as a factual lookup. Generic criteria unfairly penalize depth or reward brevity.
- **File location**: `benchmarks/comparison.ts` (after implementation)
- **Summary**:
  - **Factual**: Claim-by-claim verification against ground truth
  - **Reasoning**: Step-by-step logic audit, identify where reasoning fails
  - **Synthesis**: Coverage measurement, SIU, 25/5 rule
- **Papers/articles**:
  - arxiv:2411.15594v6
  - arxiv:2408.13006v2
- **Priority of learning**: 8/10 (essential for fair multi-category benchmarks)
- **Complexity score**: 5/10

---

## 8. Pearson Correlation

- **What is it?**: A statistical measure of linear correlation between two variables, used to compare LLM judge scores against human scores.
- **Introduced**: As the standard calibration metric for validating LLM judges.
- **Challenge it solved**: Without calibration, you don't know if your judge agrees with human experts or has systematic biases.
- **File location**: `benchmarks/calibration.ts`
- **Summary**: Calculate Pearson r between LLM scores and human annotations. Target: r >= 0.80. Values below 0.70 indicate significant misalignment requiring prompt revision.
- **Papers/articles**:
  - arxiv:2306.05685
- **Priority of learning**: 7/10 (required for production-grade judges)
- **Complexity score**: 5/10

---

## 9. 8-Module Framework

- **What is it?**: A task categorization system for LLM benchmarks: single_hop_factual, multi_hop_reasoning, synthesis, code_generation, instruction_following, rag_quality, safety, latency.
- **Introduced**: To enable category-specific evaluation and identify which systems excel at which tasks.
- **Challenge it solved**: Aggregate benchmarks hide important nuances. A system might excel at factual queries but fail at reasoning.
- **File location**: `benchmarks/types.ts`, `benchmarks/comparison-dataset.json`
- **Summary**: Categorize each test sample by task type. Evaluate and report results per category. Generate decision matrix showing which system to use for which task.
- **Papers/articles**:
  - arxiv:2309.15217
- **Priority of learning**: 6/10 (useful framework for comparative benchmarks)
- **Complexity score**: 3/10

---

## 10. Paired Bootstrap Resampling

- **What is it?**: A statistical method for measuring significance in A/B comparisons by resampling with replacement.
- **Introduced**: To generate confidence intervals and P(Superiority) scores without assuming normal distribution.
- **Challenge it solved**: Raw win rates don't tell you if the difference is statistically significant or just noise.
- **File location**: `benchmarks/statistics.ts`
- **Summary**: Resample comparison pairs 10,000 times, calculate win rate for each sample, report 95% confidence interval. P(Superiority) = fraction of samples where system A wins.
- **Papers/articles**:
  - Standard statistical method, widely used in ML evaluation
- **Priority of learning**: 5/10 (important for rigorous claims)
- **Complexity score**: 6/10

---

## 11. HCSP (Hierarchical Constraint Satisfaction Protocol)

- **What is it?**: A validation framework that distinguishes CRITICAL_GAP (logic errors, hallucinations) from STYLISTIC_PREFERENCE (minor wording issues).
- **Introduced**: To solve the "pedantic paradox" where valid content fails due to minor stylistic critiques.
- **Challenge it solved**: Without hierarchy, a spelling error is weighted the same as a factual hallucination. Critical issues get lost in noise.
- **File location**: `src/validation.ts`, `benchmarks/hcsp.ts`
- **Summary**: Categorize all critiques as CRITICAL_GAP or STYLISTIC_PREFERENCE. A single CRITICAL_GAP causes failure regardless of stylistic approval count.
- **Papers/articles**:
  - Internal framework based on constraint satisfaction literature
- **Priority of learning**: 7/10 (essential for quality validation)
- **Complexity score**: 4/10

---

## 12. Golden Dataset Strategy

- **What is it?**: A curated set of 50-100 high-fidelity test cases covering happy paths, edge cases, and failure modes.
- **Introduced**: For rapid iteration and regression testing without running full benchmarks.
- **Challenge it solved**: Full benchmarks are slow and expensive. A small, high-quality dataset enables fast feedback loops.
- **File location**: `src/__tests__/golden-cases.json`
- **Summary**: Curate ~50 representative samples. Use for quick validation (30 seconds). Only run full benchmark for releases or major changes.
- **Papers/articles**:
  - General best practice in ML evaluation
- **Priority of learning**: 6/10 (practical workflow optimization)
- **Complexity score**: 2/10

---

## Quick Reference Table

| Concept | Priority | Complexity | Primary Use |
|---------|----------|------------|-------------|
| LLM-as-a-Judge | 9 | 4 | Core evaluation paradigm |
| Symmetric Pairwise Swapping | 9 | 3 | Position bias elimination |
| Position Consistency (PC) | 8 | 2 | Bias detection metric |
| Rationale-First Prompting | 8 | 3 | Judge prompt structure |
| Task-Specific Rubrics | 8 | 5 | Fair multi-category eval |
| SIU | 7 | 4 | Verbosity mitigation |
| Pearson Correlation | 7 | 5 | Judge calibration |
| HCSP | 7 | 4 | Quality validation |
| 8-Module Framework | 6 | 3 | Task categorization |
| Golden Dataset | 6 | 2 | Fast iteration |
| 25/5 Rule | 6 | 2 | Verbosity heuristic |
| Paired Bootstrap | 5 | 6 | Statistical significance |

