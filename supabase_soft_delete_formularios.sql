-- Soft-delete para formularios F01 y VWFS.
-- Sigue el patrón ya usado en comprobantes_pago y archivos_cliente.
-- Owner del panel F01 podrá marcar formularios como eliminados; ningún admin/vendedor.

ALTER TABLE formularios_f01
  ADD COLUMN IF NOT EXISTS eliminado BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS eliminado_por TEXT,
  ADD COLUMN IF NOT EXISTS eliminado_at TIMESTAMPTZ;

ALTER TABLE formularios_vwfs
  ADD COLUMN IF NOT EXISTS eliminado BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS eliminado_por TEXT,
  ADD COLUMN IF NOT EXISTS eliminado_at TIMESTAMPTZ;

-- Índices parciales para que las queries con WHERE eliminado = false sigan siendo rápidas.
CREATE INDEX IF NOT EXISTS formularios_f01_eliminado_idx
  ON formularios_f01 (eliminado) WHERE eliminado = false;

CREATE INDEX IF NOT EXISTS formularios_vwfs_eliminado_idx
  ON formularios_vwfs (eliminado) WHERE eliminado = false;
