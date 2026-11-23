import { NextResponse } from 'next/server';
import { z } from 'zod';
import { renderLabelRequest } from '@dayson/domain';
import { getServerUserId } from '@/lib/data/server-profile';
import { printerFromEnv, sendZpl } from '@/lib/labels/print';

// Raw TCP to the printer needs the Node.js runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const modeSchema = z.enum(['download', 'print']);

/**
 * POST { template: 'pallet'|'location'|'carton', data, copies?, mode: 'download'|'print' }
 *   download  returns the ZPL text
 *   print     sends the ZPL to PRINTER_HOST:PRINTER_PORT
 * Requires a signed-in user.
 */
export async function POST(request: Request) {
  const userId = await getServerUserId();
  if (!userId) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'BAD_JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  const { mode: rawMode, ...labelRequest } = body as Record<string, unknown>;
  const mode = modeSchema.safeParse(rawMode ?? 'download');
  if (!mode.success) return NextResponse.json({ error: 'BAD_MODE' }, { status: 400 });

  let zpl: string;
  let template: string;
  let copies: number;
  try {
    const rendered = renderLabelRequest(labelRequest);
    zpl = rendered.zpl;
    template = rendered.request.template;
    copies = rendered.request.copies;
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'BAD_LABEL_DATA', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: 'BAD_LABEL_DATA', message: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  if (mode.data === 'download') {
    return new NextResponse(zpl, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${template}.zpl"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const printer = printerFromEnv();
  if (!printer) return NextResponse.json({ error: 'PRINTER_NOT_CONFIGURED' }, { status: 503 });
  try {
    await sendZpl(printer, zpl);
  } catch (err) {
    return NextResponse.json(
      { error: 'PRINTER_UNREACHABLE', message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, template, copies });
}
