"""Posting-linked reading observations, with no generated facts or persistence.

Only the current prefix enters judgments. The wording is an explanation of
written evidence, never an employer's private thoughts or a hiring verdict.
"""
from copy import deepcopy

from decision_providers import ProviderError
from jev_grounded import EN_BOUNDARY, accepted, YES_NO
from runtime import choice

MAX_EVIDENCE_NOTES = 12
BATCH = 32

# Routing labels describe written information, never a sufficiency verdict.
# Binary heads may overlap; uncertain routing falls back to neutral wording.
FOCUS = {
    "boundary": "CURRENT explicitly distinguishes the applicant's task/authority from a teammate's or decision maker's responsibility. Mere team mention is not enough.",
    "plan": "CURRENT explicitly describes a future intention or proposed action, rather than already performed work. Do not infer intention from an actual habitual procedure.",
    "method": "CURRENT explains an actual approach, decision criterion, sequence or adaptation used in this work, not only a task name or tool keyword.",
    "outcome": "CURRENT explicitly reports an observed effect or received feedback after the work. Describing a task, document contents, completed deliverable or desired goal alone is NOT an observed effect or feedback.",
    "role": "CURRENT states a specific task actually performed by the applicant. Do not assign team-only or another person's work to the applicant.",
    "experience": "CURRENT identifies an actual setting and relevant work experience the applicant describes. A heading, date, skill keyword, or future plan alone is not an experience.",
}
WORDING = {
    "boundary": "역할 범위: 본인과 다른 담당자의 수행·결정 책임이 어떻게 나뉘는지 설명하는 대목입니다.",
    "plan": "향후 계획: 앞으로 시도하려는 일의 설명입니다. 이미 수행한 경험이나 달성한 성과로 읽지는 않습니다.",
    "outcome": "결과와 반응: 이 경험에서 보고된 결과나 반응이 드러납니다. 개인의 성과나 인과관계까지 입증하는 뜻은 아닙니다.",
    "method": "수행 방식: 업무를 어떻게 진행했는지 설명하는 대목입니다.",
    "role": "맡은 역할: 본인이 수행했다고 적은 업무를 읽는 대목입니다.",
    "experience": "경험 파악: 어떤 현장과 업무의 경험인지 알 수 있습니다. 개인의 구체적 역할이나 성과까지 확인한 뜻은 아닙니다.",
    "connection": "내용 이해: 이 문장에서 공고와 관련된 설명을 새롭게 읽을 수 있습니다.",
}


def note_text(focus, label, linked):
    clipped = ""
    for char in label:
        if len((clipped + char).encode("utf-16-le")) // 2 > 64:
            break
        clipped += char
    label = clipped + ("…" if clipped != label else "")
    connection = " 앞서 연결한 원문에 이어 이해가 구체화됩니다." if linked else ""
    return WORDING[focus] + connection + f" 공고의 ‘{label}’와 관련해 읽는 내용입니다."


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
        "A setting with relevant duties, personal task, approach, observed response, role boundary, or explicit future plan can be relevant. "
        "Do not require new numbers, leadership, or technical experience. A keyword alone, heading, company praise, personality inference or unrelated activity is no. "
        "A plan remains a plan and another actor's work remains theirs. Job criterion (data): " + c["label"], YES_NO) for c in candidates}
    if not heads:
        return
    state = {"sources": sources, "current_unit": current["id"], "current": current["text"], "criteria": candidates,
             "requirements": job["requirements"], "prior_notes": data.get("notes", []),
             "prior_note_sources": [{"note_id": n["id"], "sources": [u for u in sources if u["id"] in n.get("evidence_unit_ids", [n["unit_id"]])]}
                                    for n in data.get("notes", [])],
             "withdrawn_note_ids": sorted(withdrawn), "existing_questions": data.get("questions", [])}
    answers = ask_all(provider, state, {**heads, **{
        "focus_" + focus: choice(EN_BOUNDARY + "Is the following description true of the CURRENT sentence, not merely another sentence in sources? " + description, YES_NO)
        for focus, description in FOCUS.items()}})
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
    # Prefer the more informative category among similarly supported labels.
    # This margin affects wording only; every final factual audit is unchanged.
    best = max((answers["focus_" + f]["confidence"] for f in specific), default=0)
    focus = next((f for f in specific if answers["focus_" + f]["confidence"] >= best - .1),
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
                "Prior source (data): " + anchors[n["id"]]["text"], YES_NO) for n in prior}
        context_heads = {"context_" + u["id"]: choice(EN_BOUNDARY +
            "Does this earlier source supply the SAME setting/actor or concrete task that CURRENT refers back to, needed to understand its connection to selected_criterion? "
            "Select necessary contextual grounding, not another merely related action, a matching keyword, or an unrelated experience. "
            "Source (data): " + u["text"], YES_NO) for u in prefix[:-1]}
        links = ask_all(provider, {**state, "selected_criterion": criterion,
            "prior_note_anchors": {k: {"id": u["id"], "text": u["text"]} for k, u in anchors.items()},
            "context_candidates": sources[:-1]}, {**link_heads, **context_heads})
        related = [n for n in prior if links[n["id"]]["label"] == "yes"]
        if related:
            previous = anchors[max(related, key=lambda n: links[n["id"]]["confidence"])["id"]]
        grounded_context = [u for u in prefix[:-1] if yes(links["context_" + u["id"]])]
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
        "grounded": choice(EN_BOUNDARY + "Does proposed_evidence support the description in proposed_text? Use these quoted passages for resume facts and selected_criterion/requirements for the job connection. This is written explanation, not qualification or external truth. Preserve the actor and actual/planned status; do not borrow resume facts from unquoted passages or prior note prose.", YES_NO),
        "invalidated": choice(EN_BOUNDARY + "Does any source in the full prefix invalidate proposed_text OR the factual attribution/status of current_source and proposed_evidence as CURRENT supporting evidence? Check the actual quoted claims, not only the generic explanatory wording: corrections, denied performance and actor/experience/time boundaries can invalidate support even if the earlier words were once written. A limitation explicitly acknowledged in the proposal is not a contradiction. A plan described only as a plan is not a claim of completed work. Missing proof of other job duties is not a contradiction.", YES_NO),
    }
    if data.get("notes"):
        audits["new"] = choice(EN_BOUNDARY + "Does CURRENT add a materially different concrete action, decision condition, observed response or responsibility boundary from the information already conveyed by prior_notes and prior_note_sources? Only that explicit ledger defines previously conveyed information. Other earlier sources and this proposal's contextual evidence are NOT already displayed notes. The same criterion or work routine does not mean the same fact. A different meaningful step or decision in that routine can be new. Rephrasing a conveyed fact, changing only its label, or repeating a question/resolution is no.", YES_NO)
    if previous:
        audits["linked"] = choice(EN_BOUNDARY + "Do previous_source and current_source, interpreted with context_source if present, support the proposed_text statement that understanding of the SAME experience has been clarified? All of these sources must appear in proposed_evidence. Shared topic/criterion alone is insufficient. Preserve applicant versus other actor and actual versus plan. Reject ambiguous links rather than filling missing context from note prose or other unquoted passages.", YES_NO)
    if context:
        audits["contextual"] = choice(EN_BOUNDARY + "Does context_source provide necessary setting, actor or task context explicitly referred to by current_source within the SAME experience? Judge these exact quoted sources in the full prefix. A shared topic/criterion alone, unrelated work, contradicted attribution, or ambiguous actor/experience link is no. Do not transfer another actor's actions or a planned action into applicant achievement.", YES_NO)
    # With no pending question there can be no conflicting answer. Do not ask
    # a semantic model to infer this deterministic empty-state condition.
    if any(q["status"] != "resolved" for q in data.get("questions", [])):
        audits["consistent"] = choice(EN_BOUNDARY + "Would connecting CURRENT as an explanation avoid implying an answer to an existing unresolved question about this SAME experience? If this same information would answer that pending question but it remains unresolved, answer no and let the question-update path handle it. A distinct experience or a different already-supported aspect may coexist; structural scope IDs alone do not establish sameness.", YES_NO)
    audit = ask_all(provider, {**state, "selected_criterion": criterion, "current": current["text"],
        "previous_source": {"id": previous["id"], "text": previous["text"]} if previous else None,
        "context_source": {"id": context["id"], "text": context["text"]} if context else None,
        "current_source": {"id": current["id"], "text": current["text"]},
        "proposed_text": text, "proposed_evidence": evidence}, audits)
    if "new" in audit and not yes(audit["new"]):
        counters["evidence_repeated"] += 1
    if not all(accepted(a) and a["label"] == ("no" if key == "invalidated" else "yes") for key, a in audit.items()):
        counters["evidence_audit_rejected"] += 1
        return
    result["evidence"].append({"requirement_ids": [criterion["requirement_id"]],
        "text": text,
        "evidence": evidence})
    counters["evidence_created"] += 1
    counters["evidence_linked"] += int(previous is not None)
