import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from './supabaseClient'

// El esquema no le pone un default a `paseador_id`: la política de RLS lo
// valida, pero cada insert tiene que mandarlo. Resolverlo una vez acá evita
// repetir `getUser()` en cada pantalla y que se cuele un insert sin dueño.
//
// La configuración también vive acá porque es la raíz de las dos cascadas
// (tarifa y duración) y la consultan casi todas las pantallas.

const Ctx = createContext(null)

export function ProveedorSesion({ children }) {
  const [sesion, setSesion] = useState(undefined) // undefined = todavía no se sabe
  const [config, setConfig] = useState(null)
  const [cargandoConfig, setCargandoConfig] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSesion(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_e, s) => setSesion(s))
    return () => listener.subscription.unsubscribe()
  }, [])

  const paseadorId = sesion?.user?.id ?? null

  const recargarConfig = useCallback(async () => {
    if (!paseadorId) {
      setConfig(null)
      setCargandoConfig(false)
      return
    }
    const { data, error } = await supabase
      .from('configuracion')
      .select('*')
      .eq('paseador_id', paseadorId)
      .maybeSingle()

    if (error) console.error('No se pudo leer la configuración', error)
    setConfig(data ?? null)
    setCargandoConfig(false)
  }, [paseadorId])

  useEffect(() => {
    setCargandoConfig(true)
    recargarConfig()
  }, [recargarConfig])

  const salir = useCallback(() => supabase.auth.signOut(), [])

  return (
    <Ctx.Provider value={{ sesion, paseadorId, config, cargandoConfig, recargarConfig, salir }}>
      {children}
    </Ctx.Provider>
  )
}

export function useSesion() {
  const valor = useContext(Ctx)
  if (!valor) throw new Error('useSesion se usó fuera de <ProveedorSesion>')
  return valor
}
