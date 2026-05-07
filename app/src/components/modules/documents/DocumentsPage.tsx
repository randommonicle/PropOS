/**
 * @file DocumentsPage.tsx
 * @description Document vault — central file store for all PropOS documents.
 * Responsible for: listing, uploading, searching documents. Triggers AI summary on upload.
 * NOT responsible for: AI processing (Edge Function handles it), PDF generation (Reports module).
 */
import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { STORAGE_BUCKETS } from '@/lib/constants'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, Input, Badge } from '@/components/ui'
import { Upload, FileText, Search, Download } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'
import type { Database } from '@/types/database'

type Document = Database['public']['Tables']['documents']['Row']

const DOCUMENT_TYPES = [
  'all', 'lease', 'certificate', 'insurance', 'invoice',
  'report', 'notice', 'correspondence', 'minutes', 'plans',
  'golden_thread', 'compliance', 'other',
]

export function DocumentsPage() {
  const firmContext = useAuthStore(s => s.firmContext)
  const [documents, setDocuments] = useState<Document[]>([])
  const [filtered, setFiltered] = useState<Document[]>([])
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!firmContext?.firmId) return
    loadDocuments(firmContext.firmId)
  }, [firmContext?.firmId])

  useEffect(() => {
    let list = documents
    if (typeFilter !== 'all') list = list.filter(d => d.document_type === typeFilter)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(d =>
        d.filename.toLowerCase().includes(q) ||
        d.description?.toLowerCase().includes(q) ||
        d.ai_summary?.toLowerCase().includes(q)
      )
    }
    setFiltered(list)
  }, [documents, search, typeFilter])

  async function loadDocuments(firmId: string) {
    const { data } = await supabase
      .from('documents')
      .select('*')
      .eq('firm_id', firmId)
      .order('upload_date', { ascending: false })
    setDocuments(data ?? [])
    setLoading(false)
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !firmContext) return
    setUploading(true)

    const path = `${firmContext.firmId}/${Date.now()}_${file.name}`
    const { error: storageError } = await supabase.storage
      .from(STORAGE_BUCKETS.DOCUMENTS)
      .upload(path, file)

    if (storageError) {
      alert('Upload failed: ' + storageError.message)
      setUploading(false)
      return
    }

    const { error: dbError } = await supabase.from('documents').insert({
      firm_id: firmContext.firmId,
      document_type: 'other',
      filename: file.name,
      storage_path: path,
      mime_type: file.type,
      file_size_bytes: file.size,
    })

    if (dbError) {
      alert('Failed to record document: ' + dbError.message)
    } else {
      loadDocuments(firmContext.firmId)
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleDownload(doc: Document) {
    const { data } = await supabase.storage
      .from(STORAGE_BUCKETS.DOCUMENTS)
      .createSignedUrl(doc.storage_path, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  return (
    <div>
      <PageHeader title="Document Vault" description="Central document store for all properties">
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
          <Upload className="h-4 w-4 mr-1" />
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
        <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
      </PageHeader>

      <div className="p-8">
        {/* Filters */}
        <div className="flex gap-4 mb-6">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search documents…"
              className="pl-9"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select
            className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
          >
            {DOCUMENT_TYPES.map(t => (
              <option key={t} value={t}>{t === 'all' ? 'All types' : t.replace('_', ' ')}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground text-sm">No documents found.</p>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">File</th>
                  <th className="text-left px-4 py-2 font-medium">Type</th>
                  <th className="text-left px-4 py-2 font-medium">Summary</th>
                  <th className="text-left px-4 py-2 font-medium">Uploaded</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {filtered.map(doc => (
                  <tr key={doc.id} className="border-t hover:bg-muted/50">
                    <td className="px-4 py-3">
                      <p className="font-medium truncate max-w-48">{doc.filename}</p>
                      {doc.file_size_bytes && (
                        <p className="text-xs text-muted-foreground">{(doc.file_size_bytes / 1024).toFixed(0)} KB</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className="capitalize">{doc.document_type.replace('_', ' ')}</Badge>
                    </td>
                    <td className="px-4 py-3 max-w-64">
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {doc.ai_summary ?? 'No summary yet.'}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(doc.upload_date)}
                    </td>
                    <td className="px-4 py-3">
                      <Button variant="ghost" size="icon" onClick={() => handleDownload(doc)}>
                        <Download className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
