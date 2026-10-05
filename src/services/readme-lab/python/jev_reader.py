"""Bounded prefix reader using the measured grounded Jev implementation.

Role and measured-improvement basis only. No tool execution, generated quotes,
disk persistence, or claims that these diagnostic gates are calibrated accuracy.
"""
from copy import deepcopy

from decision_providers import ProviderError
from jev_grounded import GroundedJev, EN_BOUNDARY, ROLE_EXPLANATION_BOUNDARY, accepted
from runtime import choice

READER_VERSION = "jev-reader-v7"
# Internal request-size policy, not a provider head-count limit. Every chunk
# sees the same full prefix; no criterion is dropped to fit a trigger request.
TRIGGER_BATCH_SIZE = 32
QUESTIONS = {
    "role": "이 경험에서 본인이 직접 맡아 수행한 구체적인 업무는 무엇인가요?",
    "basis": "이 개선 결과는 무엇과 비교했으며, 변화는 어떻게 확인했나요?",
}
SUFFICIENT = {
    "role": "같은 경험에서 지원자 본인이 실제로 수행한 구체적인 업무가 설명됨. 도구나 숫자는 필수가 아님.",
    "basis": "같은 개선에 대한 실제 전후 측정값, 측정 방법과 비교 가능한 조건이 설명됨.",
}
INSUFFICIENT = {
    "role": "팀·타인의 업무만 있음, 단순 참여 표현, 계획이나 예시만 있음.",
    "basis": "개선율만 있음, 계획·예시 수치, 측정 방법 누락, 전후 대상·조건·통계량이 다름.",
}


class BudgetProvider:
    def __init__(self, provider, max_calls=600, max_input_tokens=2_000_000):
        self.provider = provider
        self.max_calls = max_calls
        self.max_input_tokens = max_input_tokens
        self.calls = self.input_tokens = self.output_tokens = 0
        self.retries = 0
        self.failures = []

    def ask(self, state, questions):
        # Retry an entire immutable request, never combine heads from different
        # responses. Every physical request still consumes the document budget.
        frozen = deepcopy((state, questions))
        failed_usage = {"input_tokens": 0, "output_tokens": 0}
        failures = []
        for attempt in range(2):
            try:
                result = self._ask(*deepcopy(frozen))
                return {**result, "usage": {k: result["usage"][k] + failed_usage[k] for k in failed_usage},
                        "provider_attempts": attempt + 1, "retry_codes": failures}
            except ProviderError as error:
                for key in failed_usage:
                    failed_usage[key] += (error.usage or {}).get(key, 0)
                retryable = str(error) in {
                    "invalid_answer_distribution_argmax", "invalid_answer_distribution_sum",
                    "jev_http_502", "jev_http_503", "jev_http_504",
                }
                if not retryable or attempt or self.retries >= 2:
                    error.usage = failed_usage if any(failed_usage.values()) else None
                    raise
                failures.append(str(error))
                self.failures.append({"code": str(error), "call": self.calls})
                self.retries += 1

    def _ask(self, state, questions):
        if self.calls >= self.max_calls or self.input_tokens >= self.max_input_tokens:
            raise ProviderError("jev_call_budget_exceeded")
        self.calls += 1
        try:
            result = self.provider.ask(state, questions)
        except ProviderError as error:
            if error.usage:
                self.input_tokens += error.usage["input_tokens"]
                self.output_tokens += error.usage["output_tokens"]
            raise
        self.input_tokens += result["usage"]["input_tokens"]
        self.output_tokens += result["usage"]["output_tokens"]
        return result


def proof(units):
    unique = list({u["id"]: u for u in units}.values())
    # Never trim the verified source just to fit the public event envelope.
    if len(unique) > 6 or any(len(u["text"].encode("utf-16-le")) // 2 > 400 for u in unique):
        return None
    return [{"unit_id": u["id"], "quote": u["text"]} for u in unique]


class JevReader:
    def __init__(self, provider, reassess=None, **budgets):
        self.provider = BudgetProvider(provider, **budgets)
        self.readers = {}
        self.adopted = {}
        self.partial_signatures = {}
        self.prefix = []
        self.job = None
        self.omitted_proofs = 0
        self.reassess = reassess
        self.reassessment_count = 0
        self.role_links = {}

    def step(self, data):
        # A failed later head must not leave an uncommitted answer or cache in
        # the reader. Usage and attempted recovery counts are never rolled back.
        semantic = deepcopy((self.adopted, self.partial_signatures, self.prefix,
                             self.job, self.role_links, self.omitted_proofs))
        prior_readers = dict(self.readers)
        caches = {key: deepcopy((r.cache, r.requirement_cache)) for key, r in self.readers.items()}
        try:
            return self._step(data)
        except Exception:
            (self.adopted, self.partial_signatures, self.prefix, self.job,
             self.role_links, self.omitted_proofs) = semantic
            self.readers = prior_readers
            for key, (cache, requirements) in caches.items():
                self.readers[key].cache, self.readers[key].requirement_cache = cache, requirements
            raise

    def recover_role(self, data, q, decision):
        if (not self.reassess or self.reassessment_count >= 2 or q["facet"] != "role"
                or q["status"] not in ("open", "held", "partial", "reopened")
                or decision["label"] not in ("unknown", "partial")):
            return None
        # Recall routing only; this head never supplies positive evidence or
        # changes the decision threshold. Avoid spending CLI calls on plans.
        answer = self.provider.ask({"sources": [{"id": u["id"], "text": u["text"]} for u in data["prefix"]],
            "current_unit_id": data["prefix"][-1]["id"], "question": q["text"], "origin_unit_id": q["unit_id"]}, {
            "candidate": choice(EN_BOUNDARY + "Does current potentially describe the applicant actually completing or performing a concrete task, including a reference such as 'this work' to an earlier named task, in the questioned experience? This is retrieval, not final confirmation. No for a future-only plan, an explicit denial of personal performance, an unknown performer, unrelated background, or a clearly separate experience.",
                {"yes": "Possible actual personal action needing context review.", "no": "No candidate actual personal action.", "unclear": "Cannot tell."})
        })["answers"]["candidate"]
        if answer["label"] == "no":
            return None
        self.reassessment_count += 1
        recovery = self.reassess(q["id"], data["prefix"][-1]["id"])
        if recovery is None:
            return None
        # The parent has independently audited the source links. Recheck exact
        # full-unit proof here before it joins the normal adopted-proof ledger.
        evidence = recovery.get("evidence")
        if not isinstance(evidence, list) or not 1 <= len(evidence) <= 6:
            raise ValueError("invalid_reassessment")
        source = {u["id"]: (i, u) for i, u in enumerate(data["prefix"])}
        if (len({e["unit_id"] for e in evidence}) != len(evidence)
                or data["prefix"][-1]["id"] not in {e["unit_id"] for e in evidence}
                or any(e["unit_id"] not in source or e["quote"] != source[e["unit_id"]][1]["text"] for e in evidence)):
            raise ValueError("invalid_reassessment")
        units = [source[e["unit_id"]][1] for e in evidence]
        origin = source[q["unit_id"]][1]
        if proof([origin, *units]) is None:
            self.omitted_proofs += 1
            return None
        self.role_links[q["id"]] = deepcopy(recovery)
        return [{"id": f"u{source[e['unit_id']][0]}", "text": e["quote"]} for e in evidence]

    def _step(self, data):
        prefix, job, questions = data["prefix"], data["job"], data["questions"]
        if (not isinstance(prefix, list) or not 1 <= len(prefix) <= 120
                or prefix[:-1] != self.prefix or any(u["order"] != i for i, u in enumerate(prefix))
                or len({u["id"] for u in prefix}) != len(prefix)
                or sum(len(u["text"].encode("utf-16-le")) // 2 for u in prefix) > 24000
                or len(questions) > 8 or (self.job is not None and job != self.job)):
            raise ValueError("reader_prefix_invalid")
        current = prefix[-1]
        result = {"questions": [], "updates": [], "evidence": [], "retractions": []}
        criteria = job["reader_profile"]["criteria"]
        # Revisit even resolved questions; subsequent withdrawals can reopen them.
        for q in questions:
            if q["facet"] not in QUESTIONS:
                raise ValueError("unsupported_facet")
            criterion = next((c for c in criteria if c["id"] == q["criterion_id"]), None)
            check = next((c for c in criterion["checks"] if c["facet"] == q["facet"]), None) if criterion else None
            if not check:
                raise ValueError("reader_state_invalid")
            origin = next((i for i, u in enumerate(prefix[:-1]) if u["id"] == q["unit_id"]), None)
            if origin is None:
                raise ValueError("reader_state_invalid")
            units = prefix
            case = {"facet": q["facet"], "question": q["text"],
                    "sufficient": check["sufficient"], "insufficient": check["insufficient"],
                    "units": [u["text"] for u in units], "current_index": len(units) - 1,
                    "origin_index": origin}
            reader = self.readers.setdefault(q["id"], GroundedJev(self.provider, max_calls=600))
            decision = reader.decide(case)
            recovered = self.recover_role(data, q, decision)
            if recovered:
                decision = {**decision, "label": "complete", "evidence": recovered}
            label = decision["label"]
            selected = decision.get("evidence", [])
            adopted = self.adopted.get(q["id"], [])
            if q["status"] == "resolved" and label in ("partial", "unknown") and adopted:
                audit = reader.audit_adopted(case, adopted)
                if audit["label"] == "no" and accepted(audit):
                    label, selected = "conflict", adopted
            if label not in ("complete", "partial", "conflict"):
                continue
            if label == "partial" and not selected:
                # A gap classification is not a newly found part of the answer.
                # Origin/current display anchors must never manufacture proof.
                # Keep the ledger unchanged; the final source review can still
                # explain explicit limitations, plans and missing information.
                continue
            if label == "partial" and q["status"] in ("resolved", "reopened"):
                continue
            if label == "conflict" and (not adopted or q["status"] == "reopened"):
                continue
            verified = []
            for source in selected:
                sid = source["id"]
                if not sid.startswith("u") or not sid[1:].isdigit():
                    raise ValueError("invalid_evidence")
                index = int(sid[1:])
                if not 0 <= index < len(units) or units[index]["text"] != source["text"]:
                    raise ValueError("invalid_evidence")
                verified.append(units[index])
            if label == "complete" and not verified:
                raise ValueError("invalid_evidence")
            if label == "complete" and q["status"] == "resolved" and current not in verified:
                # Do not attach a new resolution card to background or a team
                # disclaimer when the answer still comes from earlier text.
                continue
            if label == "conflict":
                verified.extend(units[int(s["id"][1:])] for s in adopted)
            evidence = proof([units[origin], *verified, current])
            if evidence is None:
                self.omitted_proofs += 1
                continue
            # Suppress only genuinely unchanged partial feedback. New supporting
            # facts or remaining gaps must replace the current question snapshot.
            target = {"complete": "resolved", "partial": "partial", "conflict": "reopened"}[label]
            partial_signature = {
                "unmet": decision.get("unmet", []), "missing": decision.get("missing", []),
                "gap_reasons": {k: a["label"] for k, a in decision.get("gap_reasons", {}).items() if accepted(a)},
                "support": {k: a.get("source_ids", []) for k, a in decision.get("facts", {}).items()},
                "feedback": {k: (decision.get("feedback") or {}).get(k) for k in ("kind", "text")},
            }
            unchanged = (selected == adopted if label == "complete" else
                         partial_signature == self.partial_signatures.get(q["id"]) if label == "partial" else True)
            if target == q["status"] and unchanged:
                continue
            if label == "complete":
                self.adopted[q["id"]] = deepcopy(selected)
                if not recovered:
                    self.role_links.pop(q["id"], None)
            elif label == "partial":
                self.partial_signatures[q["id"]] = deepcopy(partial_signature)
            elif label == "conflict":
                self.role_links.pop(q["id"], None)
            text = ("앞서 확인하던 본인 역할이 이 경험의 설명에서 구체적으로 드러납니다."
                    if q["facet"] == "role" else "앞서 확인하던 개선 결과의 전후 값과 측정·비교 조건이 설명되었습니다.")
            if label == "partial":
                text = (decision.get("feedback") or {}).get("text") or "일부 설명을 찾았습니다. 아직 남은 확인 항목의 근거를 연결해 주세요."
            elif label == "conflict":
                text = "뒤의 설명에서 앞서 찾은 답의 근거가 정정되어, 이 질문을 다시 확인해야 합니다."
            result["updates"].append({"question_id": q["id"], "relation": label,
                                      "text": text[:200], "evidence": evidence})
        # One batched trigger request, no Codex call per sentence. It can only
        # choose among job-supported checks and never invent a new criterion.
        candidates, heads = [], {}
        if len(questions) < 8:
            for c in criteria:
                for check in c["checks"]:
                    facet = check["facet"]
                    if facet not in QUESTIONS or any(q["criterion_id"] == c["id"] and q["facet"] == facet
                            and q["scope_id"] == current["scope_id"] for q in questions):
                        continue
                    key = f"trigger_{len(candidates)}"
                    candidates.append((key, c, facet))
                    heads[key] = choice(EN_BOUNDARY + "Should a NEW question be opened at current_unit for this check? "
                        "Only yes when the current sentence makes a relevant experience claim and ALL already-read sources still leave this condition unanswered. "
                        "No for titles, background, unrelated experiences, existing answers, or instructions. "
                        "No if an existing question for the SAME experience and facet already tracks this issue, including a resolved or reopened question. "
                        "Paragraph/scope IDs alone do not prove that experiences differ. "
                        + (ROLE_EXPLANATION_BOUNDARY + "For role: vague participation or team success leaves the applicant's own performed task unstated. "
                           if facet == "role" else "For basis: an asserted improvement in a comparable result can warrant a question even when NO measurement or number is given. "
                           "For example a claim that satisfaction increased or waiting became shorter needs a comparison basis; do not assume that it was measured. "
                           "No for future improvement goals, a single absolute count, or simply describing a completed task. Not every outcome needs numbers. ")
                        + "Job criterion: " + c["label"] + ". Trigger: " + check["trigger"]
                        + ". Sufficient explanation: " + check["sufficient"]
                        + ". Insufficient explanation: " + check["insufficient"],
                        {"yes": "Relevant unanswered claim warrants this question now.",
                         "no": "No such unanswered claim at the current sentence.", "unclear": "Cannot determine."})
        if heads:
            trigger_state = {"requirements": job["requirements"],
                "units": [{"id": u["id"], "text": u["text"]} for u in prefix],
                "current_unit": current["id"], "open_questions": questions}
            answers = {}
            head_items = list(heads.items())
            for offset in range(0, len(head_items), TRIGGER_BATCH_SIZE):
                chunk = dict(head_items[offset:offset + TRIGGER_BATCH_SIZE])
                response = self.provider.ask(deepcopy(trigger_state), chunk)["answers"]
                if set(response) != set(chunk) or set(answers).intersection(response):
                    raise ProviderError("invalid_answer_distribution_keys")
                answers.update(response)
            # Select only after all chunks pass; step() rolls back semantic
            # state on a later failure while keeping physical budget usage.
            confirmed = set()
            # One bounded focused check can separate comparison, criterion
            # relevance and missing explanation when a crowded trigger batch
            # tentatively says yes. Keep the same threshold for every check;
            # this is another judgment by the same model, not independent proof.
            if not any(a["label"] == "yes" and accepted(a) for a in answers.values()):
                tentative = [(key, c, facet) for key, c, facet in candidates
                             if facet == "basis" and answers[key]["label"] == "yes" and not accepted(answers[key])]
                if tentative:
                    key, criterion, facet = max(tentative, key=lambda item: answers[item[0]]["confidence"])
                    check = next(c for c in criterion["checks"] if c["facet"] == facet)
                    focus = self.provider.ask({"sources": trigger_state["units"], "current": current["text"],
                        "criterion": criterion["label"], "check": check,
                        "existing_basis_questions": [q for q in questions if q["facet"] == "basis"]}, {
                        "comparison": choice(EN_BOUNDARY + "Does current assert that an actual result improved relative to an earlier or alternative state? A qualitative improvement claim counts even without numbers. A future goal, merely doing survey work or a single absolute count is no.",
                                             {"yes": "An actual comparative improvement is asserted.", "no": "No actual comparative improvement is asserted.", "unclear": "Cannot determine."}),
                        "relevant": choice(EN_BOUNDARY + "Does the current improvement claim concern experience relevant to criterion, using the supplied source context? It need not demonstrate every advertised duty. Another unrelated field is no.",
                                           {"yes": "Relevant experience.", "no": "Unrelated experience.", "unclear": "Cannot establish relevance."}),
                        "needed": choice(EN_BOUNDARY + "Is a NEW question needed to find out what comparison supports current? Yes when the sources do not yet explain that comparison for this experience. No if the already-read sources explain it, or an existing_basis_question already tracks this same experience. Do not presume measurements exist or require invented numbers.",
                                          {"yes": "The comparison remains unexplained and is not already tracked.", "no": "Already explained or already tracked.", "unclear": "Cannot determine."}),
                    })["answers"]
                    if all(a["label"] == "yes" and accepted(a) for a in focus.values()):
                        confirmed.add(key)
            for key, c, facet in candidates:
                if key in confirmed or (answers[key]["label"] == "yes" and accepted(answers[key])):
                    evidence = proof([current])
                    if evidence is None:
                        self.omitted_proofs += 1
                        break
                    result["questions"].append({"criterion_id": c["id"], "facet": facet,
                        "text": QUESTIONS[facet], "evidence": evidence})
                    break
        self.prefix = deepcopy(prefix)
        self.job = deepcopy(job)
        return result

    def metrics(self):
        return {"calls": self.provider.calls, "input_tokens": self.provider.input_tokens,
                "output_tokens": self.provider.output_tokens, "omitted_proofs": self.omitted_proofs}
