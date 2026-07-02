# V31 - Corrección de carga en Alertas Académicas

Esta versión corrige el problema de creación de Alertas Académicas y refuerza columnas en Supabase.

## Qué corrige

1. La carga individual de Alertas Académicas ahora envía `nivel_prioridad` y también mantiene `variable_adicional` por compatibilidad.
2. `Muy Alto` ya no se guarda como prioridad `Muy Alta`, sino como `Alta` con puntaje 95, para evitar errores si la tabla tenía una restricción de valores.
3. Si el beneficiario no tiene `region_id`, la página muestra un mensaje específico.
4. Los errores técnicos ahora se muestran mejor para identificar si falta columna, RLS, región, FK o restricción.
5. El SQL asegura que existan columnas requeridas en `alertas_academicas`, `orientaciones_beneficiario` y `solicitudes_eliminacion_casos`.

## Orden de uso

1. Ejecutar en Supabase SQL Editor:

```sql
09_v31_parche_fix_alertas_y_validaciones.sql
```

2. Subir a GitHub Pages:

```text
index.html
config.js
plantilla_alertas_academicas.csv
```

3. Recargar la página con Ctrl + F5.
4. Probar crear una Alerta Académica.

## Diagnóstico adicional si aún falla

Ejecutar:

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public'
  and table_name='alertas_academicas'
order by ordinal_position;

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.alertas_academicas'::regclass;
```

