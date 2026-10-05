"""Posting-linked reading observations, with no generated facts or persistence.

Only the current prefix enters judgments. The wording is an explanation of
written evidence, never an employer's private thoughts or a hiring verdict.
"""
from copy import deepcopy

from decision_providers import ProviderError
from jev_grounded import EN_BOUNDARY, accepted, YES_NO, ROLE_CONTRACT
from runtime import choice

MAX_EVIDENCE_NOTES = 12
BATCH = 32

# Routing labels describe written information, never a sufficiency verdict.
# Binary heads may overlap; uncertain routing falls back to neutral wording.
FOCUS = {
    "boundary": "CURRENT explicitly distinguishes the applicant's task/authority from a teammate's or decision maker's responsibility. Mere team mention is not enough.",
    "preparation": "CURRENT describes actual studying, practice, training, or another concrete preparation activity by the applicant. Learning is not employment or demonstrated application. A sentence may also mention a future exam; do not turn current study into future-only activity or future exams into earned credentials.",
    "motivation": "CURRENT explicitly explains the applicant's reason for choosing or wanting this role/activity. Company praise or a bare statement of interest alone is not a personal reason.",
    "plan": "CURRENT explicitly describes a future intention or proposed action, rather than already performed work. Do not infer intention from an actual habitual procedure.",
    "method": "CURRENT explains an actual approach, decision criterion, sequence or adaptation used in this work, not only a task name or tool keyword.",
    "outcome": "CURRENT explicitly reports a completed deliverable, attained goal, observed effect or received feedback after an activity. A task name, uncompleted goal or desired effect alone is not an actual result. Preserve team versus individual attribution; reporting the result does not prove sole causation.",
    "role": "CURRENT states a specific action actually performed by the applicant, including study or non-employment activities. Do not assign team-only or another person's work to the applicant.",
    "experience": "CURRENT identifies an actual setting and relevant work experience the applicant describes. A heading, date, skill keyword, or future plan alone is not an experience.",
}
WORDING = {
    "boundary": "역할 범위: 본인과 다른 담당자의 수행·결정 책임이 어떻게 나뉘는지 설명하는 대목입니다.",
    "preparation": "학습과 준비: 관련 지식이나 활동을 익히고 준비한 내용입니다. 실무 수행 경력과는 구분해 읽습니다.",
    "motivation": "지원 이유: 이 직무나 활동을 선택하거나 배우고 싶은 이유를 설명합니다.",
    "plan": "향후 계획: 앞으로 하려는 일도 담겨 있습니다. 계획한 부분은 이미 수행한 경험이나 달성한 성과로 읽지는 않습니다.",
    "outcome": "결과와 반응: 이 활동에서 완료한 결과물이나 보고된 결과·반응이 드러납니다. 개인의 성과나 인과관계까지 입증하는 뜻은 아닙니다.",
    "method": "수행 방식: 활동을 어떻게 진행했는지 설명하는 대목입니다.",
    "role": "맡은 역할: 본인이 수행했다고 적은 구체적인 활동을 읽는 대목입니다.",
    "experience": "경험 파악: 어떤 현장과 업무의 경험인지 알 수 있습니다. 개인의 구체적 역할이나 성과까지 확인한 뜻은 아닙니다.",
    "connection": "내용 이해: 이 문장에서 공고와 관련된 설명을 새롭게 읽을 수 있습니다.",
}


def factual_text(focus, linked):
    connection = " 앞서 연결한 원문에 이어 이해가 구체화됩니다." if linked else ""
    return WORDING[focus] + connection


def note_text(focus, label, linked):
    clipped = ""
    for char in label:
        if len((clipped + char).encode("utf-16-le")) // 2 > 64:
            break
        clipped += char
    label = clipped + ("…" if clipped != label else "")
    return factual_text(focus, linked) + f" 공고의 ‘{label}’와 관련해 읽는 내용입니다."


def yes(answer):
    return answer["label"] == "yes" and accepted(answer)


def ask_all(provider, state, heads):
    answers = {}
    items = list(heads.items())
    for offset in range(0, len(items), BATCH):
        chunk = dict(items[offset:offset + BATCH])
        response = provider.ask(deepcopy(state), chunk)["answers"]
        if set(response) != set(chunk):
            raise ProviderError("invalid_answer_distribution_keys")
        answers.update(response)
    return answers


def observations(data, provider, result, proof, counters):
    prefix, job = data["prefix"], data["job"]
    current = prefix[-1]
    sources = [{"id": u["id"], "text": u["text"]} for u in prefix]
    notes = [n for n in data.get("notes", []) if n["kind"] == "evidence" and not n.get("question_id")]
    withdrawn = {r["note_id"] for r in data.get("note_retractions", [])}
    active = [n for n in notes if n["id"] not in withdrawn]
    # Revalidate the specific explanation, not the person's ability. All
    # previously active cards are checked; no keyword/scope shortcut drops one.
    if active:
        note_sources = {n["id"]: [u for u in sources if u["id"] in n["evidence_unit_ids"]] for n in active}
        heads = {n["id"]: choice(EN_BOUNDARY +
            "Has ANY later source in this prefix invalidated a quoted fact OR reassigned supporting work to another actor, so this earlier note can no longer serve as CURRENT evidence of the applicant's described work in the SAME experience? "
            "Check note_sources, including original actor attribution and performed/planned status, not just the generic wording of the note. "
            "A later explicit correction that a colleague did the originally described work invalidates that support even if the note only calls it an approach. "
            "Recheck all text even if the correction was missed on an earlier step. Unrelated corrections, another experience or added detail are no. "
            "A note about a stated plan is not a claim of completion. Earlier note (data): " + n["text"], YES_NO) for n in active}
        state = {"sources": sources, "current_unit": current["id"], "notes": active, "note_sources": note_sources}
        answers = ask_all(provider, state, heads)
        for n in active:
            if not yes(answers[n["id"]]):
                continue
            origin = next(u for u in prefix if u["id"] == n["unit_id"])
            later = [u for u in prefix if u["order"] > origin["order"]]
            links = ask_all(provider, {**state, "target_note": n, "target_sources": note_sources[n["id"]]}, {
                u["id"]: choice(EN_BOUNDARY + "Does THIS source explicitly correct a supporting fact or reassign work in target_sources to another actor in the SAME experience, so target_note can no longer serve as current support for that original attribution/status? Check the quoted work even when note prose is generic. Mere absence, external unverified truth, another experience, compatible extra detail, or a claim subsequently reinstated is no. Source (data): " + u["text"], YES_NO)
                for u in later})
            corrections = [u for u in later if yes(links[u["id"]])]
            if not corrections:
                continue
            correction = max(corrections, key=lambda u: links[u["id"]]["confidence"])
            # Two accepted decisions are required: full-prefix invalidation,
            # then an exact later source confirming that same, still-valid
            # correction. A third generic re-judgment conflated retaining some
            # role evidence with retaining the entire corrected quotation.
            units = [u for u in prefix if u["id"] in n["evidence_unit_ids"] or u in (correction, current)]
            evidence = proof(units)
            if evidence is None:
                counters["proof_omitted"] += 1
                continue
            result["retractions"].append({"note_id": n["id"],
                "text": "지금까지 읽은 정정 내용을 반영해 앞서 연결한 근거를 갱신합니다. 이전 메모는 당시 읽은 기록으로 남기며 현재 설명의 근거로 사용하지 않습니다.",
                "evidence": evidence})
            withdrawn.add(n["id"])
            counters["evidence_retracted"] += 1

    # A question/answer card already expresses this sentence's change. Avoid
    # piling a generic positive observation onto it, and keep reading bounded.
    if result["questions"] or result["updates"] or result["retractions"]:
        return
    if len(notes) >= MAX_EVIDENCE_NOTES:
        counters["evidence_cap_steps"] += 1
        return
    criteria = data["job"]["reader_profile"]["criteria"]
    # Question sufficiency checks serve a different decision. Including them
    # here made relevance/understanding audits demand a complete qualification.
    candidates = [{k: c[k] for k in ("id", "requirement_id", "label")} for c in criteria]
    heads = {c["id"]: choice(EN_BOUNDARY +
        "Does CURRENT describe information relevant to at least ONE aspect of this job criterion in the applicant's written experience or explicitly stated plan? "
        "Judge relevance only, NOT whether the applicant has met the entire criterion or supplied all its required detail. "
        "A relevant setting, personal activity, actual study/preparation, reason for applying, approach, completed result, role boundary, or explicit future plan can be relevant. "
        "Do not require new numbers, leadership, or technical experience. A keyword alone, heading, company praise, personality inference or unrelated activity is no. "
        "A plan remains a plan and another actor's work remains theirs. Job criterion (data): " + c["label"], YES_NO) for c in candidates}
    if not heads:
        return
    state = {"sources": sources, "current_unit": current["id"], "current": current["text"], "criteria": candidates,
             "requirements": job["requirements"],
             "prior_note_sources": [{"note_id": n["id"], "sources": [u for u in sources if u["id"] in n.get("evidence_unit_ids", [n["unit_id"]])]}
                                    for n in data.get("notes", [])],
             "withdrawn_note_ids": sorted(withdrawn), "existing_questions": data.get("questions", [])}
    answers = ask_all(provider, state, {**heads, **{
        "focus_" + focus: choice(EN_BOUNDARY + "Is the following description true of the CURRENT sentence, not merely another sentence in sources? " + description, YES_NO)
        for focus, description in FOCUS.items()},
        "needs_context": choice(EN_BOUNDARY +
            "Does CURRENT need an earlier factual source to identify its actor, specific activity or referenced object? "
            "No for a self-contained statement, merely useful extra background, an application question/instruction, or a heading. "
            "Context must clarify an actual reference, not just connect a sentence to a broad criterion.", YES_NO)})
    counters["evidence_candidates"] += len(heads)
    counters["evidence_abstained"] += sum(not accepted(answers[k]) or answers[k]["label"] == "unclear" for k in heads)
    # Review the strongest candidate, not always the first posting item. Ties
    # retain posting order; this number is not presented as a calibrated score.
    # This is retrieval, not admission. An uncertain yes can receive a focused
    # source review; the final relevance/factual audits still require .75.
    ranked = sorted((c for c in candidates if answers[c["id"]]["label"] == "yes"),
                    key=lambda c: -answers[c["id"]]["confidence"])
    if not ranked:
        counters["evidence_irrelevant"] += 1
        return
    criterion = ranked[0]
    specific = [f for f in FOCUS if f != "experience" and yes(answers["focus_" + f])]
    # Pick the strongest accepted wording candidate, preserving order on ties.
    # This is a routing preference, not a calibrated accuracy comparison.
    best = max((answers["focus_" + f]["confidence"] for f in specific), default=0)
    focus = next((f for f in specific if answers["focus_" + f]["confidence"] == best),
                 "experience" if yes(answers["focus_experience"]) else "connection")
    if focus == "connection":
        counters["understanding_focus_uncertain"] += 1

    # Link original passages, never use a prior interpretation as factual proof.
    # Only one prior anchor is inherited, leaving space for later retraction.
    prior = [n for n in active if n["id"] not in withdrawn]
    previous = context = None
    if len(prefix) > 1:
        anchors = {n["id"]: next(u for u in prefix if u["id"] == n["unit_id"]) for n in prior}
        link_heads = {
            n["id"]: choice(EN_BOUNDARY +
                "Do CURRENT and this PRIOR SOURCE describe the SAME experience, with CURRENT materially clarifying the earlier role, approach, outcome or responsibility boundary? "
                "Use the full source context to verify the link, not the prior note's interpretation. Merely sharing a job criterion, topic, paragraph or vocabulary is not enough. "
                "A separate experience, repeated fact, unsupported pronoun link or change from a future plan to claimed completion is no. "
                "Prior source is prior_note_anchors[" + n["id"] + "].", YES_NO) for n in prior}
        context_heads = {"context_" + u["id"]: choice(EN_BOUNDARY +
            "Does this earlier source supply the SAME setting/actor or concrete task that CURRENT refers back to, needed to understand its connection to selected_criterion? "
            "Select necessary factual grounding from the applicant account, not another merely related action, a matching keyword, or an unrelated experience. Application questions, instructions and rubric headings do not provide factual actor/activity evidence and must not be selected. "
            "Source (data): " + u["text"], YES_NO) for u in prefix[:-1]} if answers["needs_context"]["label"] == "yes" else {}
        links = ask_all(provider, {**state, "selected_criterion": criterion,
            "prior_note_anchors": {k: {"id": u["id"], "text": u["text"]} for k, u in anchors.items()}}, {**link_heads, **context_heads})
        related = [n for n in prior if yes(links[n["id"]])]
        if related:
            previous = anchors[max(related, key=lambda n: links[n["id"]]["confidence"])["id"]]
        grounded_context = [u for u in prefix[:-1] if "context_" + u["id"] in links and yes(links["context_" + u["id"]])]
        if grounded_context:
            context = max(grounded_context, key=lambda u: links["context_" + u["id"]]["confidence"])
    chosen = {u["id"] for u in (context, previous, current) if u is not None}
    evidence = proof([u for u in prefix if u["id"] in chosen])
    if evidence is None:
        counters["proof_omitted"] += 1
        return
    text = note_text(focus, criterion["label"], previous is not None)
    audits = {
        "relevant": choice(EN_BOUNDARY + "Do the exact proposed_evidence passages concern at least one aspect of selected_criterion in the described experience or explicitly marked plan? This is relevance, not sufficiency or proof of all duties. A shared keyword or unrelated experience alone is no.", YES_NO),
        "invalidated": choice(EN_BOUNDARY + "Is there an explicit source anywhere in the full prefix that contradicts a factual claim used by proposed_text or changes the quoted activity to another actor, a different experience, or merely planned/hypothetical work? Check the quoted claims and their framing, including later corrections. A compatible refinement, another unrelated activity, a limitation acknowledged in the note, missing detail or lack of external verification is NOT a contradiction. A plan accurately described as a plan is not a claim of completion.", YES_NO),
    }
    if data.get("notes"):
        audits["new"] = choice(EN_BOUNDARY + "Does CURRENT add a materially different concrete fact: an action, decision condition, completed deliverable, attained goal, observed response, personal reason, preparation or responsibility boundary? Compare the facts in prior_note_sources. Only that explicit ledger defines previously conveyed information. Other earlier sources and this proposal's contextual evidence are NOT already displayed notes. The same criterion or work routine does not mean the same fact. A different meaningful step or decision in that routine can be new. A broad question or vague claim in that ledger does not already convey the later concrete example, personal reason, study activity or completed result. A question is not its answer. Rephrasing the same concrete fact or only changing its label is no.", YES_NO)
    if previous:
        audits["linked"] = choice(EN_BOUNDARY + "Do previous_source and current_source, interpreted with context_source if present, support the proposed_text statement that understanding of the SAME experience has been clarified? All of these sources must appear in proposed_evidence. Shared topic/criterion alone is insufficient. Preserve applicant versus other actor and actual versus plan. Reject ambiguous links rather than filling missing context from note prose or other unquoted passages.", YES_NO)
    if context:
        audits["contextual"] = choice(EN_BOUNDARY + "Does context_source provide necessary setting, actor or task context explicitly referred to by current_source within the SAME experience? Judge these exact quoted sources in the full prefix. A shared topic/criterion alone, unrelated work, contradicted attribution, or ambiguous actor/experience link is no. Do not transfer another actor's actions or a planned action into applicant achievement.", YES_NO)
    # With no pending question there can be no conflicting answer. Do not ask
    # a semantic model to infer this deterministic empty-state condition.
    if any(q["status"] != "resolved" for q in data.get("questions", [])):
        audits["overclaims_answer"] = choice(EN_BOUNDARY + "Does proposed_text incorrectly assert that an existing unresolved question is FULLY answered? A source-grounded detail or partial answer may be described while a question about another aspect remains pending. A note about a distinct experience does not answer the old question. Judge the assertion in proposed_text, not whether the whole criterion is satisfied; factual validity is audited separately.", YES_NO)
    # A useful answer fragment must update its own question rather than leave
    # an apparently contradictory standalone positive beside an open question.
    pending = [q for q in data.get("questions", []) if q["status"] in ("open", "held", "partial")
               and q.get("unit_id") in {u["id"] for u in prefix}]
    question_context = {}
    for q in pending:
        c = next((c for c in criteria if c["id"] == q.get("criterion_id")), None)
        check = next((check for check in c["checks"] if check["facet"] == q.get("facet")), None) if c else None
        if check is None:
            raise ValueError("reader_state_invalid")
        contract = ROLE_CONTRACT if q["facet"] == "role" else check
        old_ids = set(q.get("evidence_unit_ids", []))
        if not old_ids <= {u["id"] for u in prefix}:
            raise ValueError("reader_state_invalid")
        question_context[q["id"]] = {
            "facet": q["facet"], "sufficient": contract["sufficient"], "insufficient": contract["insufficient"],
            "origin": next(u for u in sources if u["id"] == q["unit_id"]),
            "existing_evidence": [u for u in sources if u["id"] in old_ids],
        }
    answer_heads = {"answer_" + q["id"]: choice(EN_BOUNDARY +
        "Do proposed_evidence explicitly explain at least one NEW component of this exact pending question's answer? Judge PARTIAL SUPPORT only, not whether the whole sufficient condition is fulfilled. A question with several requested components can gain one component while the rest remain unanswered. "
        "It must answer the original experience and requested aspect, not just the same job criterion. "
        "Only a question explicitly asking general preparation/reasons across activities may use distinct personal preparations. "
        "Preserve actor, actual/planned status, outcome identity and all corrections; another person's work or a future plan cannot answer an own-performance question. "
        "A topical mention, question premise or merely compatible detail is no. Use this question's facet and sufficient/insufficient contract in question_context to identify an actual answer component, not a generally positive detail. This does not certify a complete answer. "
        "Question id (data): " + q["id"] + "; question (data): " + q["text"], YES_NO) for q in pending}
    retained_heads = {"retained_" + q["id"]: choice(EN_BOUNDARY +
        "Can the previously accepted partial answer in this question's exact existing_evidence bundle be retained unchanged after reading the full prefix? "
        "No if a source corrects a necessary supporting fact, changes its actor or experience, or retracts actual performance into a plan. Missing additional detail is not a correction. "
        "Use its origin and facet/sufficient/insufficient contract in question_context. Display/context anchors need not each independently answer the question, but the bundle must still support the previously found part. "
        "Do not replace missing or invalid old support with the new proposal in this check. Question id (data): " + q["id"] + "; question (data): " + q["text"], YES_NO)
        for q in pending if question_context[q["id"]]["existing_evidence"]}
    audit = ask_all(provider, {**state, "selected_criterion": criterion, "current": current["text"],
        "previous_source": {"id": previous["id"], "text": previous["text"]} if previous else None,
        "context_source": {"id": context["id"], "text": context["text"]} if context else None,
        "current_source": {"id": current["id"], "text": current["text"]},
        "proposed_text": text, "proposed_evidence": evidence,
        "question_context": question_context,
        "pending_question_origins": [{"question_id": q["id"], "source": question_context[q["id"]]["origin"]} for q in pending]}, {**audits, **answer_heads, **retained_heads})
    answer_audits = {q["id"]: audit.pop("answer_" + q["id"]) for q in pending}
    retained_audits = {q["id"]: audit.pop("retained_" + q["id"])
                       for q in pending if "retained_" + q["id"] in retained_heads}
    answered = [q for q in pending if yes(answer_audits[q["id"]])
                and (q["id"] not in retained_audits or yes(retained_audits[q["id"]]))]
    if not answered and any(yes(a) for a in answer_audits.values()):
        # This was identified as an answer, but its old proof could not safely
        # be retained. Do not reintroduce the same contradiction as a positive.
        return
    if answered:
        q = max(answered, key=lambda q: answer_audits[q["id"]]["confidence"])
        origin = next(u for u in prefix if u["id"] == q["unit_id"])
        # Jev updates replace the serving snapshot. Retain old support only
        # after its exact bundle has been re-audited; never silently truncate it.
        unit_ids = {e["unit_id"] for e in evidence} | {origin["id"], current["id"]} | set(q.get("evidence_unit_ids", []))
        linked_proof = proof([u for u in prefix if u["id"] in unit_ids])
        if linked_proof is None:
            counters["proof_omitted"] += 1
            return
    display_text = "이 질문과 관련된 구체적인 설명을 찾았습니다. 아직 확인하지 못한 부분과 구분해 읽습니다." if answered else text
    display_evidence = linked_proof if answered else evidence
    # Every displayed clause has an audit: source facts here, posting relevance
    # in relevant, and the optional connection in linked. The whole criterion
    # label is a topic, not an applicant-fact claim or a sufficiency obligation.
    # Partial answers still audit their actual copy and entire combined proof.
    audit["grounded"] = ask_all(provider, {
        "proposed_text": display_text if answered else factual_text(focus, previous is not None),
        "proposed_evidence": display_evidence,
        "question": ({"text": q["text"], "facet": q["facet"],
                      "sufficient": question_context[q["id"]]["sufficient"],
                      "insufficient": question_context[q["id"]]["insufficient"]} if answered else None),
    }, {"grounded": choice(EN_BOUNDARY +
        "Do these exact proposed_evidence quotations support the description in proposed_text? "
        "Use only these quotations for applicant facts; no unquoted prefix or prior memo interpretation may fill missing actor, activity, context or performed/planned status. "
        "Job relevance, source linking and later corrections are audited separately. "
        "If question is present, proposed_text claims ONLY that a concrete part of its answer was found, not that the whole sufficient condition or qualification is satisfied. "
        "Otherwise judge the specific role, method, outcome, preparation or plan actually described. Unsupported or ambiguous wording is no or unclear.", YES_NO)})["grounded"]
    # A low-confidence novelty comparison can be confused by undisplayed
    # prefix facts. Recheck once against only the explicit displayed ledger.
    # A confident duplicate is never retried and every factual audit still gates.
    if ("new" in audit and not accepted(audit["new"])
            and all(accepted(a) and a["label"] == ("no" if k in ("invalidated", "overclaims_answer") else "yes")
                    for k, a in audit.items() if k != "new")):
        duplicate = ask_all(provider, {
            "current_source": {"id": current["id"], "text": current["text"]},
            "proposed_evidence": evidence,
            "prior_note_sources": state["prior_note_sources"],
            "source_context": sources,
        }, {"duplicate": choice(EN_BOUNDARY +
            "Does at least one entry in prior_note_sources already convey the specific factual contribution of current_source about the SAME experience? "
            "Compare the exact activity/object, actor, action, result and planned/actual status. Similar actions in different projects or different concrete steps/results in one project are not duplicates. "
            "Use source_context only to resolve activity identity and references, never as a ledger of already displayed information. "
            "A broad question or participation claim is not its concrete answer or completed result. If no ledger entry conveys this same contribution, answer no.", YES_NO)})["duplicate"]
        audit["new"] = {"label": {"yes": "no", "no": "yes"}.get(duplicate["label"], "unclear"),
                        "confidence": duplicate["confidence"]}
    if "new" in audit and not yes(audit["new"]):
        counters["evidence_repeated"] += 1
    if not all(accepted(a) and a["label"] == ("no" if key in ("invalidated", "overclaims_answer") else "yes") for key, a in audit.items()):
        counters["evidence_audit_rejected"] += 1
        return
    if answered:
        result["updates"].append({"question_id": q["id"], "relation": "partial",
            "text": display_text, "evidence": display_evidence})
        return
    result["evidence"].append({"requirement_ids": [criterion["requirement_id"]],
        "text": text,
        "evidence": evidence})
    counters["evidence_created"] += 1
    counters["evidence_linked"] += int(previous is not None)
