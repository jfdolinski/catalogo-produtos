import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { AJUSTES_PADRAO, OPCOES_CAMERA, type AjustesCamera } from './regras';
import { BarraAcoes, Botao, Cartao, cores, LinhaBotoes } from './ui';

type Opcao = keyof typeof OPCOES_CAMERA;

/** Ajustes da câmera das fotos, guardados neste celular. Cada mudança vale na hora (e fica gravada). */
export function TelaAjustes({ ajustes, aoMudar, aoVoltar }: { ajustes: AjustesCamera; aoMudar: (a: AjustesCamera) => void; aoVoltar: () => void }) {
  const mudar = <K extends keyof AjustesCamera>(k: K, v: AjustesCamera[K]) => aoMudar({ ...ajustes, [k]: v });

  function Escolha({ campo, titulo, ajuda }: { campo: Opcao; titulo: string; ajuda?: string }) {
    return (
      <View style={estilos.grupo}>
        <Text style={estilos.rotulo}>{titulo}</Text>
        <View style={estilos.linha} accessibilityRole="radiogroup" accessibilityLabel={titulo}>
          {(OPCOES_CAMERA[campo] as readonly (readonly [AjustesCamera[Opcao], string])[]).map(([valor, nome]) => {
            const ativo = ajustes[campo] === valor;
            return (
              <Pressable
                key={String(valor)}
                accessibilityRole="radio"
                accessibilityState={{ checked: ativo }}
                onPress={() => mudar(campo, valor as never)}
                style={[estilos.chip, ativo && estilos.chipAtivo]}
              >
                <Text style={[estilos.chipTexto, ativo && estilos.chipTextoAtivo]}>{nome}</Text>
              </Pressable>
            );
          })}
        </View>
        {ajuda ? <Text style={estilos.ajuda}>{ajuda}</Text> : null}
      </View>
    );
  }

  function Chave({ campo, titulo, ajuda }: { campo: 'lanterna' | 'som'; titulo: string; ajuda?: string }) {
    return (
      <View style={[estilos.grupo, estilos.chave]}>
        <View style={{ flex: 1 }}>
          <Text style={estilos.rotulo}>{titulo}</Text>
          {ajuda ? <Text style={estilos.ajuda}>{ajuda}</Text> : null}
        </View>
        <Switch accessibilityLabel={titulo} value={ajustes[campo]} onValueChange={(v) => mudar(campo, v)} trackColor={{ true: cores.marca }} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={estilos.pagina}>
      <Text style={estilos.titulo}>Ajustes da câmera</Text>
      <Text style={estilos.texto}>Valem para as fotos dos produtos e ficam guardados neste celular.</Text>

      <Cartao>
        <Text style={estilos.secao}>Ao abrir a câmera</Text>
        <Escolha campo="camera" titulo="Câmera" />
        <Escolha campo="zoom" titulo="Zoom inicial" ajuda="Dá para ajustar o zoom de cada foto na hora; este é o ponto de partida." />
        <Escolha campo="flash" titulo="Flash na foto" />
        <Chave campo="lanterna" titulo="Lanterna acesa ao abrir" ajuda="Luz contínua, boa para embalagem brilhante. O botão Luz continua na tela." />
        <Chave campo="som" titulo="Som ao tirar a foto" />
      </Cartao>

      <Cartao>
        <Text style={estilos.secao}>Foto enviada</Text>
        <Escolha campo="formato" titulo="Formato" ajuda="Quadrado recorta o centro da foto antes de enviar." />
        <Escolha campo="qualidade" titulo="Qualidade da captura" ajuda="Alta gera arquivos maiores e demora mais para enviar no 4G." />
        <Escolha campo="ladoMaximo" titulo="Tamanho máximo" ajuda="Lado maior da foto enviada ao catálogo. Original envia no tamanho da câmera (bem mais pesado)." />
        <Escolha campo="maxFotos" titulo="Fotos por produto, de cada vez" />
      </Cartao>

    </ScrollView>
    <BarraAcoes>
      <LinhaBotoes>
        <View style={{ flex: 1 }}><Botao titulo="Restaurar o padrão" variante="secundario" onPress={() => aoMudar(AJUSTES_PADRAO)} /></View>
        <View style={{ flex: 1 }}><Botao titulo="Voltar" onPress={aoVoltar} /></View>
      </LinhaBotoes>
    </BarraAcoes>
    </View>
  );
}

const estilos = StyleSheet.create({
  pagina: { padding: 16, backgroundColor: cores.fundo, flexGrow: 1 },
  titulo: { fontSize: 22, fontWeight: '700', color: cores.texto, marginBottom: 6 },
  texto: { fontSize: 15, color: cores.texto, lineHeight: 22, marginBottom: 16 },
  secao: { fontSize: 16, fontWeight: '700', color: cores.texto, marginBottom: 10 },
  grupo: { marginBottom: 14 },
  rotulo: { fontSize: 14, fontWeight: '600', color: cores.texto, marginBottom: 6 },
  ajuda: { fontSize: 12, color: cores.suave, marginTop: 4 },
  linha: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 40, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: cores.borda, backgroundColor: cores.branco, alignItems: 'center', justifyContent: 'center' },
  chipAtivo: { borderColor: cores.marca, backgroundColor: cores.marca },
  chipTexto: { fontSize: 14, color: cores.texto },
  chipTextoAtivo: { color: cores.branco, fontWeight: '600' },
  chave: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
