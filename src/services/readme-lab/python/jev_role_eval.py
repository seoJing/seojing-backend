"""Sequential role-contract checks through the real JevReader, with a seeded question.

Synthetic provisional labels only. Does not evaluate question generation, posting
extraction, final reports or HTTP. Expected labels/states never enter inference.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import time

from decision_eval import save
from decision_providers import JevProvider, ProviderError
from jev_grounded import GroundedJev, VERSION, DECISION_THRESHOLDS
from jev_grounded_eval import load
from jev_reader import JevReader, READER_VERSION
from runtime import digest


def evaluate(data, provider, record):
    groups = defaultdict(list)
    for case in data['cases']:
        groups[case['scenario']].append(case)
    rows, checks, metrics = [], [], []
    for scenario, cases in groups.items():
        seed = cases[0]
        if any(c['units'] != seed['units'] or c.get('origin_index', 0) != 0 for c in cases):
            raise ValueError('invalid_sequential_scenario')
        targets = {c['current_index']: c for c in cases}
        if len(targets) != len(cases):
            raise ValueError('duplicate_checkpoint')
        reader = JevReader(provider)
        decisions = []

        class ObservedGrounded(GroundedJev):
            def decide(self, case, order='canonical'):
                result = super().decide(case, order)
                decisions.append(result)
                return result

        reader.readers['q1'] = ObservedGrounded(reader.provider,
            record=lambda event: record({'scenario': scenario, **event}))
        job = {'requirements': [{'id': 'r1', 'kind': 'duty', 'label': seed['units'][0], 'quote': seed['units'][0]}],
               'reader_profile': {'criteria': [{'id': 'c_r1', 'label': seed['units'][0], 'requirement_id': 'r1',
                   'checks': [{'facet': 'role', 'trigger': '본인 역할 설명',
                               'sufficient': seed['sufficient'], 'insufficient': seed['insufficient']}]}]}}
        question = {'id': 'q1', 'unit_id': 'u1', 'scope_id': 's1', 'criterion_id': 'c_r1',
                    'facet': 'role', 'text': seed['question'], 'status': 'open'}
        for index in range(max(targets) + 1):
            prefix = [{'id': f'u{i+1}', 'order': i, 'text': t, 'scope_id': 's1'} for i, t in enumerate(seed['units'][:index+1])]
            result = reader.step({'prefix': prefix, 'job': job, 'questions': [dict(question)] if index else []})
            for update in result['updates']:
                question['status'] = {'complete': 'resolved', 'partial': 'partial', 'conflict': 'reopened'}[update['relation']]
            exact = all(any(e['unit_id'] == u['id'] and e['quote'] == u['text'] for u in prefix)
                        for update in result['updates'] for e in update['evidence'])
            row = {'scenario': scenario, 'at': index, 'status': question['status'],
                   'decision': decisions[-1] if index else None, 'result': result,
                   'adopted_evidence': reader.adopted.get('q1', []), 'exact_quotes': exact}
            rows.append(row)
            if index in targets:
                expected = targets[index]
                state_ok = (question['status'] != 'resolved' if expected['expected_state'] == 'not_resolved'
                            else question['status'] == expected['expected_state'])
                allowed = row['decision']['label'] in expected['expected']
                label_ok = None if expected.get('state_only') else allowed
                current_ok = (not expected.get('require_current_evidence') or
                    any(e['id'] == f'u{index}' for e in reader.adopted.get('q1', [])))
                checks.append({'case_id': expected['id'], 'expected_labels': expected['expected'],
                               'actual_label': row['decision']['label'], 'expected_state': expected['expected_state'],
                               'actual_state': question['status'], 'label_pass': label_ok,
                               'state_pass': state_ok, 'current_evidence_pass': current_ok, 'exact_quotes': exact,
                               'compatible_label': allowed, 'pass': state_ok and allowed and current_ok and exact})
        metrics.append({'scenario': scenario, **reader.metrics()})
        print(json.dumps({'scenario': scenario, 'state': question['status']}, ensure_ascii=False), flush=True)
    return {'synthetic': True, 'human_reviewed': False, 'production_approved': False,
            'version': VERSION, 'reader_version': READER_VERSION, 'decision_thresholds': DECISION_THRESHOLDS,
            'rows': rows, 'checks': checks, 'matches': sum(c['pass'] for c in checks),
            'state_matches': sum(c['state_pass'] for c in checks),
            'strict_label_checks': sum(c['label_pass'] is not None for c in checks),
            'strict_label_matches': sum(c['label_pass'] is True for c in checks), 'scenarios': len(groups),
            'metrics': metrics, 'limits': ['Seeded question, no question-generation acceptance.',
                'No posting extraction, report or HTTP.', 'Synthetic agent labels; unknown on a strict negative is separately reported, not label success.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--allow-remote', action='store_true')
    args = parser.parse_args()
    data = load(args.data)
    args.out.mkdir(parents=True, exist_ok=False)
    sources = args.out / 'source'
    sources.mkdir()
    hashes = {}
    for path in Path(__file__).parent.glob('*.py'):
        (sources / path.name).write_bytes(path.read_bytes())
        hashes[path.name] = digest(path)
    save(args.out / 'data.json', data)
    save(args.out / 'freeze.json', {'created_at': datetime.now(timezone.utc).isoformat(),
        'data_sha256': digest(args.data), 'source_sha256': hashes, 'version': VERSION})
    started = time.monotonic()
    try:
        provider = JevProvider(args.allow_remote)
        with (args.out / 'calls.jsonl').open('x') as journal:
            def record(event):
                journal.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + '\n')
                journal.flush()
            result = evaluate(data, provider, record)
        result['elapsed_ms'] = round((time.monotonic() - started) * 1000, 3)
        save(args.out / 'run.json', result)
        print(json.dumps({k: v for k, v in result.items() if k not in ('rows', 'checks')}, ensure_ascii=False))
        return 0
    except ProviderError as error:
        save(args.out / 'failed.json', {'error': str(error), 'completed': False})
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
