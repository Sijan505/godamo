import {
  CreditApprovalStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';
import {
  approvalProblem,
  decisionProblem,
  evaluateCredit,
} from './credit-rules.js';

const D = (v: number | string) => new Prisma.Decimal(v);

describe('evaluateCredit', () => {
  it('allows billing within the limit (up to exactly the limit)', () => {
    expect(evaluateCredit(D(30000), D(50000), D(20000)).allowed).toBe(true);
    expect(
      evaluateCredit(D(30000), D(50000), D(20000)).newBalance.toString(),
    ).toBe('50000');
  });

  it('blocks billing past the limit', () => {
    const d = evaluateCredit(D(30000), D(50000), D('20000.01'));
    expect(d.allowed).toBe(false);
    expect(d.newBalance.toFixed(2)).toBe('50000.01');
  });

  it('treats a limit of 0 as cash only', () => {
    expect(evaluateCredit(D(0), D(0), D(1)).allowed).toBe(false);
    // An advance (negative balance) that covers the bill is fine.
    expect(evaluateCredit(D(-500), D(0), D(500)).allowed).toBe(true);
  });
});

describe('approvalProblem (using an approval on an invoice)', () => {
  const now = new Date('2026-09-25T10:00:00Z');
  const approved = {
    status: CreditApprovalStatus.APPROVED,
    partyId: 'party-1',
    amount: D(75000),
    expiresAt: new Date('2026-09-25T18:15:00Z'),
  };
  const invoice = { partyId: 'party-1', total: D(60000) };

  it('accepts an approved, unexpired approval for the same party within its amount', () => {
    expect(approvalProblem(approved, invoice, now)).toBeNull();
    expect(
      approvalProblem(approved, { ...invoice, total: D(75000) }, now),
    ).toBeNull();
  });

  it('rejects pending, rejected and already-used approvals', () => {
    for (const status of ['PENDING', 'REJECTED', 'USED'] as const) {
      expect(approvalProblem({ ...approved, status }, invoice, now)).toMatch(
        /pending|rejected|already been used/,
      );
    }
  });

  it('rejects another party, an expired approval, or an invoice above the approved amount', () => {
    expect(
      approvalProblem(approved, { ...invoice, partyId: 'party-2' }, now),
    ).toBe('The credit approval is for a different party');
    expect(
      approvalProblem(approved, invoice, new Date('2026-09-25T18:15:00Z')),
    ).toBe('The credit approval has expired');
    expect(
      approvalProblem(approved, { ...invoice, total: D('75000.01') }, now),
    ).toBe(
      'The credit approval covers up to Rs 75000.00, this invoice is Rs 75000.01',
    );
  });
});

describe('decisionProblem (who may approve)', () => {
  const owner = { userId: 'owner', role: UserRole.OWNER };
  const manager = { userId: 'mgr', role: UserRole.MANAGER };

  it('lets the owner decide any amount, including their own request', () => {
    expect(
      decisionProblem(owner, { amount: D(900000), requestedById: 'owner' }),
    ).toBeNull();
  });

  it('lets a manager decide only below Rs 50,000 and not their own request', () => {
    expect(
      decisionProblem(manager, {
        amount: D('49999.99'),
        requestedById: 'office',
      }),
    ).toBeNull();
    expect(
      decisionProblem(manager, { amount: D(50000), requestedById: 'office' }),
    ).toMatch(/Only the owner/);
    expect(
      decisionProblem(manager, { amount: D(100), requestedById: 'mgr' }),
    ).toBe('A manager cannot decide their own request');
  });

  it('never lets other roles decide', () => {
    expect(
      decisionProblem(
        { userId: 'x', role: UserRole.OFFICE },
        { amount: D(1), requestedById: 'y' },
      ),
    ).toMatch(/Only an owner or manager/);
  });
});

describe('evaluateCredit with overdue bills', () => {
  const overdue = [
    {
      invoiceId: 'inv-1',
      invoiceNo: 12,
      fiscalYear: '2083/84',
      invoiceDate: new Date('2026-07-20T00:00:00Z'),
      dueDate: new Date('2026-08-04T00:00:00Z'),
      daysOverdue: 51,
      outstanding: D(8000),
    },
  ];

  it('blocks with OVERDUE_INVOICES even when the limit is fine', () => {
    const d = evaluateCredit(D(8000), D(50000), D(1000), overdue, true);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('OVERDUE_INVOICES');
    expect(d.limitExceeded).toBe(false);
    expect(d.overdueInvoices).toHaveLength(1);
  });

  it('does not block on overdue bills when blockOnOverdue is off', () => {
    const d = evaluateCredit(D(8000), D(50000), D(1000), overdue, false);
    expect(d.allowed).toBe(true);
    expect(d.code).toBeNull();
    expect(d.overdueInvoices).toEqual([]);
  });

  it('reports overdue first when both rules are broken', () => {
    const d = evaluateCredit(D(49000), D(50000), D(5000), overdue, true);
    expect(d.code).toBe('OVERDUE_INVOICES');
    expect(d.limitExceeded).toBe(true);
  });
});
