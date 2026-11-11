import { useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView } from 'expo-camera';
import { Botao, cores } from './ui';

const MAXIMO = 10;

/**
 * Câmera para as fotos do produto: tira quantas quiser (até 10), mostra as miniaturas
 * (toque numa miniatura para descartar) e devolve os arquivos ao concluir.
 */
export function TelaFotos({ titulo, aoConcluir, aoCancelar }: { titulo: string; aoConcluir: (uris: string[]) => void; aoCancelar: () => void }) {
  const camera = useRef<CameraView>(null);
  const [fotos, setFotos] = useState<string[]>([]);
  const [pronta, setPronta] = useState(false);
  const [tirando, setTirando] = useState(false);
  const [lanterna, setLanterna] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function tirar() {
    if (!camera.current || tirando || fotos.length >= MAXIMO) return;
    setTirando(true);
    setErro(null);
    try {
      // Qualidade 0,7: foto nítida para o catálogo e envio leve pela rede móvel
      const foto = await camera.current.takePictureAsync({ quality: 0.7, skipProcessing: false, shutterSound: false });
      if (foto?.uri) setFotos((f) => [...f, foto.uri]);
    } catch {
      setErro('Não foi possível tirar a foto. Tente de novo.');
    } finally {
      setTirando(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <View style={estilos.topo}>
        <Text style={estilos.titulo} numberOfLines={2}>{titulo}</Text>
      </View>
      <CameraView ref={camera} style={{ flex: 1 }} facing="back" enableTorch={lanterna} onCameraReady={() => setPronta(true)} />
      {fotos.length ? (
        <ScrollView horizontal style={estilos.miniaturas} contentContainerStyle={{ gap: 8, padding: 8 }}>
          {fotos.map((uri, i) => (
            <Pressable key={uri} accessibilityLabel={`Descartar a foto ${i + 1}`} onPress={() => setFotos((f) => f.filter((x) => x !== uri))}>
              <Image source={{ uri }} style={estilos.miniatura} />
              <Text style={estilos.descartar}>✕</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={estilos.rodape}>
        {erro ? <Text style={{ color: cores.erro, marginBottom: 8 }}>{erro}</Text> : null}
        <Text style={estilos.ajuda}>
          {fotos.length ? `${fotos.length} foto${fotos.length > 1 ? 's' : ''}. Toque numa miniatura para descartar.` : 'Fotografe a frente da embalagem primeiro: ela vira a foto principal.'}
        </Text>
        <View style={estilos.linha}>
          <View style={{ flex: 1 }}><Botao titulo={lanterna ? 'Apagar luz' : 'Luz'} variante="secundario" onPress={() => setLanterna(!lanterna)} /></View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Tirar foto"
            disabled={!pronta || tirando || fotos.length >= MAXIMO}
            onPress={() => void tirar()}
            style={({ pressed }) => [estilos.disparo, (pressed || tirando || !pronta) && { opacity: 0.5 }]}
          >
            <View style={estilos.disparoMiolo} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Botao titulo={fotos.length ? `Enviar (${fotos.length})` : 'Cancelar'} variante={fotos.length ? 'primario' : 'secundario'} onPress={() => (fotos.length ? aoConcluir(fotos) : aoCancelar())} />
          </View>
        </View>
        {fotos.length ? <View style={{ marginTop: 8 }}><Botao titulo="Cancelar e descartar as fotos" variante="secundario" onPress={aoCancelar} /></View> : null}
      </View>
    </View>
  );
}

const estilos = StyleSheet.create({
  topo: { padding: 12, backgroundColor: cores.branco },
  titulo: { fontSize: 16, fontWeight: '700', color: cores.texto },
  miniaturas: { flexGrow: 0, backgroundColor: '#111' },
  miniatura: { width: 64, height: 64, borderRadius: 6 },
  descartar: { position: 'absolute', top: 2, right: 4, color: '#fff', fontWeight: '700', textShadowColor: '#000', textShadowRadius: 3 },
  rodape: { padding: 12, backgroundColor: cores.branco },
  ajuda: { fontSize: 14, color: cores.suave, marginBottom: 10 },
  linha: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  disparo: { width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: cores.marca, alignItems: 'center', justifyContent: 'center' },
  disparoMiolo: { width: 54, height: 54, borderRadius: 27, backgroundColor: cores.marca },
});
