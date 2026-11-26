import { randomUUID } from 'node:crypto';
import { conflict } from '../../shared/errors';
import type { BillLineDocument } from './bill.model';
import { GstRulesError, computeLineTax, type TaxContext } from './gst';

export interface BillLineInput {
  sourceKey: string;
  kind: BillLineDocument['kind'];
  category: BillLineDocument['category'];
  description: string;
  serviceDate: string;
  quantity: number;
  unitPaise: number;
  taxablePaise: number;
  reason?: string;
  addedBy?: string;
  approvedBy?: string | null;
}

/**
 * Builds one bill line, taxed under the rules in force on the day of the service. The tax figures
 * are copied onto the line here and never recalculated, so a later change to the rates cannot
 * change a bill that has already been posted.
 */
export function buildBillLine(
  tariffPaise: number,
  context: TaxContext,
  input: BillLineInput,
): BillLineDocument {
  try {
    const tax = computeLineTax(
      {
        category: input.category,
        taxablePaise: input.taxablePaise,
        serviceDate: input.serviceDate,
        tariffPaise,
      },
      context,
    );
    return {
      lineId: randomUUID(),
      kind: input.kind,
      sourceKey: input.sourceKey,
      category: input.category,
      description: input.description,
      serviceDate: input.serviceDate,
      quantity: input.quantity,
      unitPaise: input.unitPaise,
      taxablePaise: input.taxablePaise,
      ratePercent: tax.ratePercent,
      cgstPaise: tax.cgstPaise,
      sgstPaise: tax.sgstPaise,
      igstPaise: tax.igstPaise,
      taxPaise: tax.taxPaise,
      totalPaise: input.taxablePaise + tax.taxPaise,
      sacCode: tax.sacCode,
      ruleEffectiveFrom: tax.ruleEffectiveFrom,
      reason: input.reason ?? null,
      addedBy: input.addedBy ?? null,
      approvedBy: input.approvedBy ?? null,
      postedAt: new Date(),
    };
  } catch (error) {
    if (error instanceof GstRulesError) throw conflict(error.message, 'no_tax_rules');
    throw error;
  }
}
