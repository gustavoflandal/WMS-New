// DOC-06 §4.4 RF-EXP-030 — teste unitário puro (sem banco) da serpentina.
import { describe, expect, it } from 'vitest';
import { assignRouteSequence, sortByPickingRoute, type RouteCoordinates } from '../picking-route.util.js';

describe('picking-route.util — RF-EXP-030 (zona -> rua serpenteando -> módulo -> nível)', () => {
  it('ordena por zona (alfabética), depois rua, com serpentina de módulo alternando por rua', () => {
    const items: RouteCoordinates[] = [
      { zoneCode: 'Z1', aisle: 'A2', moduleCode: '003', level: '01' }, // rua ímpar (ordinal 1) -> módulo decrescente
      { zoneCode: 'Z1', aisle: 'A2', moduleCode: '001', level: '01' },
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '001', level: '01' }, // rua par (ordinal 0) -> módulo crescente
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '002', level: '01' },
    ];

    const sorted = sortByPickingRoute(items, (item) => item);

    expect(sorted).toEqual([
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '001', level: '01' },
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '002', level: '01' },
      { zoneCode: 'Z1', aisle: 'A2', moduleCode: '003', level: '01' },
      { zoneCode: 'Z1', aisle: 'A2', moduleCode: '001', level: '01' },
    ]);
  });

  it('ordena por nível dentro do mesmo módulo/rua', () => {
    const items: RouteCoordinates[] = [
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '001', level: '02' },
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '001', level: '00' },
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '001', level: '01' },
    ];
    const sorted = sortByPickingRoute(items, (item) => item);
    expect(sorted.map((i) => i.level)).toEqual(['00', '01', '02']);
  });

  it('ordena zonas em ordem alfabética antes de qualquer outro critério', () => {
    const items: RouteCoordinates[] = [
      { zoneCode: 'ZB', aisle: 'A1', moduleCode: '001', level: '00' },
      { zoneCode: 'ZA', aisle: 'A9', moduleCode: '099', level: '00' },
    ];
    const sorted = sortByPickingRoute(items, (item) => item);
    expect(sorted[0].zoneCode).toBe('ZA');
    expect(sorted[1].zoneCode).toBe('ZB');
  });

  it('assignRouteSequence atribui múltiplos de 10 na ordem final', () => {
    const items: RouteCoordinates[] = [
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '002', level: '00' },
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '001', level: '00' },
    ];
    const sorted = sortByPickingRoute(items, (item) => item);
    const assigned = assignRouteSequence(sorted);
    expect(assigned.map((a) => a.routeSequence)).toEqual([10, 20]);
    expect(assigned[0].item.moduleCode).toBe('001');
  });

  it('é determinística e estável para conjuntos idênticos', () => {
    const items: RouteCoordinates[] = [
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '001', level: '00' },
      { zoneCode: 'Z1', aisle: 'A1', moduleCode: '001', level: '00' },
    ];
    const sorted1 = sortByPickingRoute(items, (item) => item);
    const sorted2 = sortByPickingRoute(items, (item) => item);
    expect(sorted1).toEqual(sorted2);
  });
});
