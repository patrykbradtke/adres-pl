/**
 * Zapis do dziennika audytu - JEDNEGO dla calego systemu.
 *
 * DLACZEGO JEDEN
 *
 * Cztery rzeczy potrzebuja tego samego: dziennik zmian rekordow (etap 5.1),
 * historia wydan (4.7), pochodzenie recznej poprawki (5.4) i slad po
 * uprawnieniach. Zbudowane osobno dalyby cztery niekompatybilne dzienniki
 * i jedno pytanie "kto to zmienil", na ktore nie ma odpowiedzi.
 *
 * ODMOWA JEST ZDARZENIEM NA ROWNI Z NADANIEM
 *
 * Seria odmow to sygnal ataku albo zle nadanych rol - jedno i drugie trzeba
 * zobaczyc. Dlatego `record` przyjmuje decyzje, a nie tylko udane czynnosci,
 * a migracja 006 zaklada osobny indeks czesciowy po `decision = 'denied'`,
 * zeby alert po nich nie skanowal calosci.
 *
 * ZAPIS NIE MOZE WYWROCIC ZADANIA
 *
 * Blad zapisu do dziennika jest logowany, ale NIE przerywa obslugi. Odwrotna
 * decyzja znaczylaby, ze awaria tabeli audytu kladzie cala powierzchnie
 * administracyjna. Jednoczesnie taki blad musi byc glosny - stad poziom
 * `error` i osobny komunikat, a nie ciche polkniecie.
 */
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { Actor, Decision } from '@adres-pl/core';

export interface AuditEntry {
  actor: Actor;
  /** Czynnosc w postaci obszar.czynnosc - zwykle nazwa uprawnienia. */
  action: string;
  permission?: string;
  scopeTerc?: string;
  scopeClientId?: number;
  decision?: Decision;
  targetKind?: string;
  targetId?: string | number;
  before?: unknown;
  after?: unknown;
  /** `req.id` - ten sam, ktory wraca w naglowku x-correlation-id. */
  correlationId?: string;
  ip?: string;
}

export class Audit {
  private readonly pool: pg.Pool;
  private readonly log: FastifyBaseLogger;

  // Jawne przypisania zamiast parameter properties - Node w trybie
  // --experimental-strip-types wycina wylacznie typy i nie generuje kodu.
  constructor(pool: pg.Pool, log: FastifyBaseLogger) {
    this.pool = pool;
    this.log = log;
  }

  async record(e: AuditEntry): Promise<void> {
    const rozstrzygniecie = e.decision === undefined
      ? { decision: null, via: null, reason: null }
      : e.decision.allowed
        ? { decision: 'allowed', via: e.decision.via, reason: null }
        : { decision: 'denied', via: null, reason: e.decision.reason };

    try {
      await this.pool.query(
        `INSERT INTO panel.audit_log
           (actor_kind, actor_id, actor_label, action, permission,
            scope_terc, scope_client_id, decision, via, reason,
            target_kind, target_id, before, after, correlation_id, ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          e.actor.kind, e.actor.id, e.actor.label ?? null,
          e.action, e.permission ?? null,
          e.scopeTerc ?? null, e.scopeClientId ?? null,
          rozstrzygniecie.decision, rozstrzygniecie.via, rozstrzygniecie.reason,
          e.targetKind ?? null, e.targetId === undefined ? null : String(e.targetId),
          e.before === undefined ? null : JSON.stringify(e.before),
          e.after === undefined ? null : JSON.stringify(e.after),
          e.correlationId ?? null, e.ip ?? null,
        ]);
    } catch (err) {
      // Glosno, ale bez wywracania zadania - patrz naglowek.
      this.log.error({ err, action: e.action, actor: e.actor.id },
        'NIE UDALO SIE zapisac wpisu do dziennika audytu');
    }
  }

  /**
   * Uzycie trybu ratunkowego zapisujemy osobno i na poziomie `warn`, zeby
   * dalo sie po nim ustawic alert. Tryb ratunkowy omija silnik polityki,
   * wiec jego kazde uzycie ma byc widoczne.
   */
  async recordBreakGlass(e: AuditEntry): Promise<void> {
    this.log.warn({ action: e.action, actor: e.actor.id },
      'UZYTO TRYBU RATUNKOWEGO');
    await this.record(e);
  }
}
