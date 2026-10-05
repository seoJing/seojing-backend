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
        heads = {n["id"]: choice(EN_BOUNDARY +
            "Has ANY later source in this prefix invalidated a specific supporting fact of this earlier reading note about the SAME experience? "
            "Recheck all text even if the correction was missed on an earlier step. Unrelated corrections, another experience or added detail are no. "
            "A note about a stated plan is not a claim of completion. Earlier note (data): " + n["text"], YES_NO) for n in active}
        state = {"sources": sources, "current_unit": current["id"], "notes": active}
        answers = ask_all(provider, state, heads)
        for n in active:
            if not yes(answers[n["id"]]):
                continue
            origin = next(u for u in prefix if u["id"] == n["unit_id"])
            later = [u for u in prefix if u["order"] > origin["order"]]
            links = ask_all(provider, {**state, "target_note": n}, {
                u["id"]: choice(EN_BOUNDARY + "Does THIS source explicitly invalidate a specific supporting claim of target_note about the SAME experience, so that the note's explanation no longer holds in the full prefix? Mere absence, external unverified truth, another experience, extra detail, or a claim subsequently reinstated is no. Source (data): " + u["text"], YES_NO)
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
    candidates = criteria
    heads = {c["id"]: choice(EN_BOUNDARY +
        "Does CURRENT introduce a concrete explanation directly relevant to the supplied job criterion that is worth connecting while reading? "
        "Require source-supported action, approach, outcome or an explicitly stated intention ONLY when this criterion asks for that intention. "
        "A skill keyword, heading, company praise, unsupported personality inference or merely repeating an earlier note is no. "
        "Do not mistake another person's work, a hypothetical example or a plan for performed work. A plan may support an intention/approach criterion only as a plan. "
        "This is an explanation found in the document, NOT proof of every requirement, competence, truth or employability. "
        "Job criterion (data): " + c["label"], YES_NO) for c in candidates}
    if not heads:
        return
    state = {"sources": sources, "current_unit": current["id"], "criteria": candidates,
             "requirements": job["requirements"], "prior_notes": data.get("notes", []),
             "withdrawn_note_ids": sorted(withdrawn), "existing_questions": data.get("questions", [])}
    answers = ask_all(provider, state, heads)
    counters["evidence_candidates"] += len(heads)
    counters["evidence_abstained"] += sum(not accepted(a) or a["label"] == "unclear" for a in answers.values())
    # Review the strongest candidate, not always the first posting item. Ties
    # retain posting order; this number is not presented as a calibrated score.
    ranked = sorted((c for c in candidates if yes(answers[c["id"]])),
                    key=lambda c: -answers[c["id"]]["confidence"])
    if not ranked:
        return
    criterion = ranked[0]
    audits = {
        "grounded": choice(EN_BOUNDARY + "Does CURRENT itself contain a concrete explanation directly related to selected_criterion, with actor, experience and actual/planned status preserved in ALL sources? Do not borrow missing positive facts from another source. A merely mentioned keyword, team-only claim presented as personal work, hypothetical example or unrelated activity is no. A clearly stated plan counts only for a criterion explicitly asking for intention or planned approach, without claiming actual performance.", YES_NO),
        "new": choice(EN_BOUNDARY + "Does connecting CURRENT add a specific useful explanation beyond prior_notes for this criterion and experience? Repeated wording or a card merely restating an earlier question/resolution is no. Paragraph boundaries alone do not make an experience new.", YES_NO),
        "valid": choice(EN_BOUNDARY + "Can the explanation in CURRENT be used as written evidence for this criterion without ignoring any contradiction, correction, different actor or hypothetical framing in sources? This does not certify skills, external facts or all job requirements.", YES_NO),
    }
    # With no pending question there can be no conflicting answer. Do not ask
    # a semantic model to infer this deterministic empty-state condition.
    if any(q["status"] != "resolved" for q in data.get("questions", [])):
        audits["consistent"] = choice(EN_BOUNDARY + "Would connecting CURRENT as an explanation avoid implying an answer to an existing unresolved question about this SAME experience? If this same information would answer that pending question but it remains unresolved, answer no and let the question-update path handle it. A distinct experience or a different already-supported aspect may coexist; structural scope IDs alone do not establish sameness.", YES_NO)
    audit = provider.ask({**state, "selected_criterion": criterion, "current": current["text"]}, audits)["answers"]
    if not all(yes(a) for a in audit.values()):
        counters["evidence_audit_rejected"] += 1
        return
    evidence = proof([current])
    if evidence is None:
        counters["proof_omitted"] += 1
        return
    label = criterion["label"]
    if len(label) > 80:
        label = label[:79] + "…"
    result["evidence"].append({"requirement_ids": [criterion["requirement_id"]],
        "text": f"공고의 ‘{label}’와 연결되는 구체적인 설명이 나왔습니다. 이 문장을 해당 요건을 이해하는 근거로 연결합니다.",
        "evidence": evidence})
    counters["evidence_created"] += 1
