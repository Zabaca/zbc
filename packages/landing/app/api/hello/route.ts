export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json({
    message: 'hello from the SSR API route',
    at: new Date().toISOString(),
  })
}
