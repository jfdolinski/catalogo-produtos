import { useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView } from 'expo-camera';
import type { Produto } from './api';
import type { AjustesCamera } from './regras';
import { Botao, cores } from './ui';

/**
 * Câmera para as fotos do produto: tira quantas quiser (até o máximo dos ajustes), mostra as miniaturas
 * (toque numa miniatura para descartar) e devolve os arquivos ao concluir.
 * Câmera, zoom, flash, lanterna, formato, qualidade e som vêm dos Ajustes deste celular.
 */
export function TelaFotos({ produto, ajustes, aoConcluir, aoCancelar }: { produto: Produto; ajustes: AjustesCamera; aoConcluir: (uris: string[]) => void; aoCancelar: () => void }) {
  const MAXIMO = ajustes.maxFotos;
  const codigos = produto.barcodes.map((b) => b.code).join(' · ');
  const camera = useRef<CameraView>(null);
  const [fotos, setFotos] = useState<string[]>([]);
  const [pronta, setPronta] = useState(false);
  const [tirando, setTirando] = useState(false);
  const [lanterna, setLanterna] = useState(ajustes.lanterna);
  const [zoom, setZoom] = useState(ajustes.zoom);
  const mudarZoom = (passo: number) => setZoom((z) => Math.round(Math.min(1, Math.max(0, z + passo)) * 10) / 10);
  const [erro, setErro] = useState<string | null>(null);

  async function tirar() {
    if (!camera.current || tirando || fotos.length >= MAXIMO) return;
    setTirando(true);
    setErro(null);
    try {
      // Qualidade 0,7: foto nítida para o catálogo e envio leve pela rede móvel
      const foto = await camera.current.takePictureAsync({ quality: ajustes.qualidade, skipProcessing: false, shutterSound: ajustes.som });
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
        {/* Para conferir que a foto é do produto certo antes de fotografar */}
        <Text style={estilos.titulo} numberOfLines={2}>{produto.name}</Text>
        <Text style={estilos.detalhe} numberOfLines={1}>Código: {codigos || 'sem código'}</Text>
        <Text style={estilos.detalhe} numberOfLines={1}>Fabricante: {produto.manufacturer || 'não informado'}{produto.brand ? `  ·  Marca: ${produto.brand}` : ''}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <CameraView
          ref={camera}
          style={{ flex: 1 }}
          facing={ajustes.camera}
          zoom={zoom}
          flash={ajustes.flash}
          enableTorch={lanterna}
          ratio={ajustes.formato}
          onCameraReady={() => setPronta(true)}
        />
        {/* Zoom de cada foto, a partir do zoom inicial dos ajustes */}
        <View style={estilos.zoom}>
          <Pressable accessibilityRole="button" accessibilityLabel="Diminuir o zoom" onPress={() => mudarZoom(-0.1)} disabled={zoom <= 0} style={estilos.zoomBotao}>
            <Text style={estilos.zoomTexto}>−</Text>
          </Pressable>
          <Text style={estilos.zoomValor}>{zoom ? `zoom ${Math.round(zoom * 100)}%` : 'sem zoom'}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Aumentar o zoom" onPress={() => mudarZoom(0.1)} disabled={zoom >= 1} style={estilos.zoomBotao}>
            <Text style={estilos.zoomTexto}>+</Text>
          </Pressable>
        </View>
        {ajustes.formato === '1:1' ? <Text style={estilos.aviso}>Formato quadrado: o centro da foto é o que vai para o catálogo.</Text> : null}
      </View>
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
          {fotos.length >= MAXIMO
            ? `Limite de ${MAXIMO} fotos de cada vez (Ajustes). Envie estas para tirar mais.`
            : fotos.length ? `${fotos.length} foto${fotos.length > 1 ? 's' : ''}. Toque numa miniatura para descartar.` : 'Fotografe a frente da embalagem primeiro: ela vira a foto principal.'}
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
  detalhe: { fontSize: 13, color: cores.suave, marginTop: 2 },
  miniaturas: { flexGrow: 0, backgroundColor: '#111' },
  miniatura: { width: 64, height: 64, borderRadius: 6 },
  descartar: { position: 'absolute', top: 2, right: 4, color: '#fff', fontWeight: '700', textShadowColor: '#000', textShadowRadius: 3 },
  rodape: { padding: 12, backgroundColor: cores.branco },
  ajuda: { fontSize: 14, color: cores.suave, marginBottom: 10 },
  linha: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  disparo: { width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: cores.marca, alignItems: 'center', justifyContent: 'center' },
  disparoMiolo: { width: 54, height: 54, borderRadius: 27, backgroundColor: cores.marca },
  zoom: { position: 'absolute', bottom: 12, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 24, paddingHorizontal: 6, paddingVertical: 4 },
  zoomBotao: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  zoomTexto: { color: '#fff', fontSize: 24, fontWeight: '700' },
  zoomValor: { color: '#fff', fontSize: 14, minWidth: 80, textAlign: 'center' },
  aviso: { position: 'absolute', top: 8, left: 8, right: 8, color: '#fff', fontSize: 12, textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 6, padding: 4 },
});
