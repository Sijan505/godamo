import { paginationDefaults, paginationFields } from '../common/pagination.js';
import { MovementType, StockCountStatus, UserRole } from '../db.js';
import { controller } from '../http/router.js';
import {
  arrayMaxSize,
  arrayMinSize,
  dateOnly,
  isArray,
  isEnum,
  isIn,
  isInt,
  isNumber,
  isPositive,
  isString,
  isUuid,
  length,
  max,
  min,
  nested,
  notEquals,
  optional,
  schema,
  toNumber,
  trim,
} from '../http/validation.js';
import * as ops from './stock-operations.js';
import * as reports from './stock-reports.js';

// ─── Request bodies ─────────────────────────────────────────────────────────

const MAX_QTY = 99_999_999_999.999;
const QTY = { maxDecimalPlaces: 3 };

const TransferItemDto = schema({
  productId: [isUuid()],
  unitId: [isUuid()],
  /** In the chosen unit */
  quantity: [isNumber(QTY), isPositive(), max(MAX_QTY)],
  /** Batch-tracked products only; omit to pick batches FEFO */
  batchId: [optional(), isUuid()],
});

const CreateTransferDto = schema({
  fromGodownId: [isUuid()],
  toGodownId: [isUuid()],
  items: [isArray(), arrayMinSize(1), arrayMaxSize(200), nested(TransferItemDto)],
  note: [optional(), trim(), isString(), length(1, 500)],
});

const AdjustmentItemDto = schema({
  productId: [isUuid()],
  unitId: [isUuid()],
  /** In the chosen unit. Positive adds stock, negative removes it. */
  quantity: [isNumber(QTY), notEquals(0), min(-MAX_QTY), max(MAX_QTY)],
  /** Batch-tracked products: required when adding; omit when removing to pick FEFO */
  batchId: [optional(), isUuid()],
});

const CreateAdjustmentDto = schema({
  godownId: [isUuid()],
  type: [isIn([MovementType.ADJUSTMENT, MovementType.DAMAGE])],
  reason: [trim(), isString(), length(3, 500)],
  items: [isArray(), arrayMinSize(1), arrayMaxSize(200), nested(AdjustmentItemDto)],
});

const CountItemDto = schema({
  productId: [isUuid()],
  /** Required for batch-tracked products */
  batchId: [optional(), isUuid()],
  unitId: [isUuid()],
  /** Physically counted, in the chosen unit */
  countedQty: [isNumber(QTY), min(0), max(MAX_QTY)],
});

const CreateCountDto = schema({
  godownId: [isUuid()],
  note: [optional(), trim(), isString(), length(1, 500)],
  items: [isArray(), arrayMinSize(1), arrayMaxSize(500), nested(CountItemDto)],
});

const ListCountsQueryDto = schema(
  {
    godownId: [optional(), isUuid()],
    status: [optional(), isEnum(StockCountStatus)],
    ...paginationFields,
  },
  { defaults: paginationDefaults },
);

const StockListQueryDto = schema(
  {
    /** Omit for all godowns */
    godownId: [optional(), isUuid()],
    /** Matches name, SKU or barcode */
    search: [optional(), trim(), isString(), length(1, 100)],
    categoryId: [optional(), isUuid()],
    ...paginationFields,
  },
  { defaults: paginationDefaults },
);

const StockCardQueryDto = schema({
  godownId: [optional(), isUuid()],
  /** Nepal date, inclusive */
  from: [optional(), dateOnly()],
  /** Nepal date, inclusive */
  to: [optional(), dateOnly()],
});

const GodownFilterQueryDto = schema({
  godownId: [optional(), isUuid()],
});

const ExpiringQueryDto = schema(
  {
    days: [optional(), toNumber(), isInt(), min(1), max(730)],
    godownId: [optional(), isUuid()],
  },
  { defaults: { days: 30 } },
);

// ─── Routes ─────────────────────────────────────────────────────────────────

const { OWNER, MANAGER, GODOWN } = UserRole;
const r = controller('/stock');

// Reports (everyone)
r.get('/', { query: StockListQueryDto }, ({ user, query }) => reports.list(user, query));
r.get('/low', { query: GodownFilterQueryDto }, ({ user, query }) => reports.low(user, query.godownId));
r.get('/expiring', { query: ExpiringQueryDto }, ({ user, query }) => reports.expiring(user, query));
r.get('/valuation', ({ user }) => reports.valuation(user));

// Stock card: every movement with a running balance
r.get('/:productId/card', { params: { productId: 'uuid' }, query: StockCardQueryDto }, ({ user, params, query }) =>
  reports.card(user, params.productId, query),
);

// Operations
r.post('/transfers', { roles: [OWNER, MANAGER, GODOWN], body: CreateTransferDto }, ({ user, body }) =>
  ops.transfer(user, body),
);
r.post('/adjustments', { roles: [OWNER, MANAGER], body: CreateAdjustmentDto }, ({ user, body }) =>
  ops.adjust(user, body),
);
r.get('/counts', { roles: [OWNER, MANAGER, GODOWN], query: ListCountsQueryDto }, ({ user, query }) =>
  ops.listCounts(user, query),
);
r.get('/counts/:id', { roles: [OWNER, MANAGER, GODOWN], params: { id: 'uuid' } }, ({ user, params }) =>
  ops.findCount(user, params.id),
);
r.post('/counts', { roles: [OWNER, MANAGER, GODOWN], body: CreateCountDto }, ({ user, body }) =>
  ops.createCount(user, body),
);
r.post(
  '/counts/:id/apply',
  { roles: [OWNER, MANAGER], status: 200, params: { id: 'uuid' } },
  ({ user, params }) => ops.applyCount(user, params.id),
);

export const stockRoutes = r;
