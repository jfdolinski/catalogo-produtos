import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import { useCameraPermissions } from 'expo-camera';
import { apagarSessao, clienteDa, ErroApi, ErroEnvio, lerSessao, type Produto, type Sessao } from './api';
import { baixarEInstalar, versaoInstalada, versaoNova } from './atualizacao';
import { LeitorCodigo } from './LeitorCodigo';
import { codigoDeBarras, gtinValido } from './regras';
import { TelaFotos } from './TelaFotos';
import { TelaNovo } from './TelaNovo';
import { TelaProduto } from './TelaProduto';
import { TelaVincular } from './TelaVincular';
import { Alerta, Botao, cores } from './ui';

const SEM_CAMERA = 'Sem permissão para usar a câmera. Libere nas configurações do Android.';

export function App() {
  const [carregando, setCarregando] = useState(true);
  const [sessao, setSessao] = useState<Sessao | null>(null);
  const [motivo, setMotivo] = useState<string | null>(null);

  useEffect(() => {
    void lerSessao().then((s) => {
      setSessao(s);
      setCarregando(false);
    });
  }, []);

  const encerrar = useCallback((razao: string | null) => {
    void apagarSessao();
    setSessao(null);
    setMotivo(razao);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={{ flex: 1, backgroundColor: cores.branco }} edges={['top', 'bottom']}>
        {/* A tela encolhe com o teclado: no Android novo ele fica por cima do conteúdo. */}
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'web' ? undefined : 'padding'}>
          {carregando ? (
            <View style={estilos.centro}><ActivityIndicator size="large" color={cores.marca} /></View>
          ) : sessao ? (
            <Principal sessao={sessao} encerrar={encerrar} />
          ) : (
            <TelaVincular motivo={motivo} aoVincular={(s) => { setMotivo(null); setSessao(s); }} />
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

// Fluxo: ler o código → produto cadastrado? câmera para as fotos → conferir; não cadastrado? cadastrar → câmera → conferir.
type Tela =
  | { qual: 'ler' }
  | { qual: 'camera-codigo' }
  | { qual: 'buscando'; codigo: string }
  | { qual: 'novo'; codigo: string }
  | { qual: 'fotos'; produto: Produto }
  | { qual: 'enviando'; produto: Produto; total: number; feitas: number }
  | { qual: 'produto'; produto: Produto; aviso?: string | null };

function Principal({ sessao, encerrar }: { sessao: Sessao; encerrar: (razao: string | null) => void }) {
  const api = useMemo(() => clienteDa(sessao, () => encerrar('Este celular foi desvinculado ou o usuário foi desativado. Vincule de novo pelo painel.')), [sessao, encerrar]);
  const [tela, setTela] = useState<Tela>({ qual: 'ler' });
  const [digitado, setDigitado] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [resumo, setResumo] = useState<string | null>(null);
  // Atualização: versão nova encontrada, baixando, instalador aberto ou falha
  const [atualizacao, setAtualizacao] = useState<{ versao: string; estado: 'baixando' | 'instalador' | 'erro'; detalhe?: string } | null>(null);
  const baixando = useRef(false);
  const [permissao, pedirPermissao] = useCameraPermissions();

  const atualizar = useCallback(async (versao: string) => {
    if (baixando.current) return;
    baixando.current = true;
    setAtualizacao({ versao, estado: 'baixando' });
    try {
      await baixarEInstalar(sessao.servidor, versao);
      setAtualizacao({ versao, estado: 'instalador' });
    } catch (e) {
      setAtualizacao({ versao, estado: 'erro', detalhe: e instanceof Error ? e.message : String(e) });
    } finally {
      baixando.current = false;
    }
  }, [sessao.servidor]);

  // Confere o vínculo ao abrir (sem internet não desvincula). Versão nova do app: baixa e abre o instalador
  // sozinho, ao abrir e sempre que o app volta para a frente.
  useEffect(() => {
    api.eu().catch(() => undefined);
    const conferir = () => {
      if (Platform.OS !== 'android') return;
      void versaoNova(sessao.servidor).then((v) => {
        if (v) void atualizar(v);
        else setAtualizacao(null);
      });
    };
    conferir();
    const s = AppState.addEventListener('change', (estado) => estado === 'active' && conferir());
    return () => s.remove();
  }, [api, sessao.servidor, atualizar]);

  /** Pede a permissão da câmera quando preciso; false = negada (o erro já fica na tela). */
  async function temCamera(): Promise<boolean> {
    const p = permissao?.granted ? permissao : await pedirPermissao();
    if (!p.granted) setErro(SEM_CAMERA);
    return p.granted;
  }

  async function fotografar(produto: Produto, aviso: string | null = null) {
    setTela((await temCamera()) ? { qual: 'fotos', produto } : { qual: 'produto', produto, aviso: aviso ? `${aviso} ${SEM_CAMERA}` : SEM_CAMERA });
  }

  async function buscar(texto: string, lidoPelaCamera: boolean) {
    setErro(null);
    setResumo(null);
    const r = codigoDeBarras(texto);
    if ('erro' in r) {
      setTela({ qual: 'ler' });
      return setErro(lidoPelaCamera ? `O código lido não é de produto (${texto.slice(0, 40)}).` : r.erro);
    }
    if (!lidoPelaCamera && [8, 12, 13, 14].includes(r.codigo.length) && !gtinValido(r.codigo)) {
      setTela({ qual: 'ler' });
      return setErro(`O código ${r.codigo} tem o último número (dígito verificador) errado. Confira o que foi digitado.`);
    }
    setTela({ qual: 'buscando', codigo: r.codigo });
    try {
      const achou = await api.porCodigo(r.codigo);
      setDigitado('');
      if (achou.found && achou.product) {
        // Achou: vai direto para a câmera das fotos
        await fotografar(achou.product);
      } else setTela({ qual: 'novo', codigo: r.codigo });
    } catch (e) {
      setTela({ qual: 'ler' });
      setErro(e instanceof ErroApi ? e.message : 'Não foi possível buscar o código.');
    }
  }

  async function enviar(produto: Produto, uris: string[], jaEnviadas = 0) {
    const total = jaEnviadas + uris.length;
    setTela({ qual: 'enviando', produto, total, feitas: jaEnviadas });
    try {
      const atualizado = await api.enviarFotos(produto.id, uris, (n) => setTela({ qual: 'enviando', produto, total, feitas: jaEnviadas + n }));
      setTela({ qual: 'produto', produto: { ...atualizado, pending: produto.pending }, aviso: `${total} foto${total > 1 ? 's enviadas' : ' enviada'}.` });
    } catch (e) {
      // As fotos ficam no aparelho só nesta tela: avisa e deixa tentar de novo só as que faltam
      const enviadas = e instanceof ErroEnvio ? e.enviadas : 0;
      const faltam = uris.slice(enviadas);
      const atual = async () => (enviadas || jaEnviadas ? ((await api.produto(produto.id).catch(() => null)) ?? produto) : produto);
      const parte = enviadas + jaEnviadas ? `${enviadas + jaEnviadas} de ${total} já foram enviadas. ` : '';
      Alert.alert('Fotos não enviadas', `${parte}${e instanceof ErroApi ? e.message : 'Falha no envio.'}`, [
        { text: 'Descartar', style: 'destructive', onPress: () => void atual().then((p) => setTela({ qual: 'produto', produto: { ...p, pending: produto.pending } })) },
        { text: `Tentar de novo (${faltam.length})`, onPress: () => void enviar(produto, faltam, jaEnviadas + enviadas) },
      ]);
    }
  }

  function sair() {
    Alert.alert('Desvincular este celular?', 'Para usar de novo, será preciso ler um QR code novo no painel.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Desvincular',
        style: 'destructive',
        onPress: () => {
          api.desvincular().catch(() => undefined).finally(() => encerrar(null));
        },
      },
    ]);
  }

  if (tela.qual === 'camera-codigo') {
    return <LeitorCodigo aoLer={(c) => void buscar(c, true)} aoCancelar={() => setTela({ qual: 'ler' })} />;
  }
  if (tela.qual === 'fotos') {
    const produto = tela.produto;
    return <TelaFotos titulo={produto.name} aoConcluir={(uris) => void enviar(produto, uris)} aoCancelar={() => setTela({ qual: 'produto', produto })} />;
  }

  const voltarParaLeitura = (texto: string | null = null) => {
    setTela({ qual: 'ler' });
    setErro(null);
    setResumo(texto);
  };

  return (
    <View style={{ flex: 1, backgroundColor: cores.fundo }}>
      <View style={estilos.topo}>
        <Pressable accessibilityRole="button" accessibilityLabel="Início" onPress={() => tela.qual !== 'enviando' && voltarParaLeitura()} style={{ flex: 1 }}>
          <Text style={estilos.marca}>Catálogo</Text>
          <Text style={estilos.usuario} numberOfLines={1}>{sessao.usuario.name} · {new URL(sessao.servidor).host}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={sair} hitSlop={10}><Text style={estilos.sair}>Sair</Text></Pressable>
      </View>

      {tela.qual === 'novo' ? (
        <TelaNovo api={api} codigo={tela.codigo} aoVoltar={() => voltarParaLeitura()} aoCadastrar={(p) => void fotografar(p, 'Produto cadastrado.')} />
      ) : tela.qual === 'produto' ? (
        <TelaProduto key={tela.produto.id} api={api} inicial={tela.produto} aviso={tela.aviso} aoFotografar={(p) => void fotografar(p)} aoProximo={(t) => voltarParaLeitura(t)} />
      ) : tela.qual === 'enviando' ? (
        <View style={estilos.centro}>
          <ActivityIndicator size="large" color={cores.marca} />
          <Text style={estilos.texto}>Enviando foto {Math.min(tela.feitas + 1, tela.total)} de {tela.total}: {tela.produto.name}…</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={estilos.pagina} keyboardShouldPersistTaps="handled">
          {atualizacao ? (
            <Pressable disabled={atualizacao.estado === 'baixando'} onPress={() => void atualizar(atualizacao.versao)}>
              <Alerta tipo="aviso">
                {atualizacao.estado === 'baixando'
                  ? `Baixando a versão ${atualizacao.versao} do aplicativo…`
                  : atualizacao.estado === 'instalador'
                    ? `Versão ${atualizacao.versao}: toque em Atualizar na tela do Android. Se ela fechou, toque aqui.`
                    : `Não foi possível atualizar para a versão ${atualizacao.versao} (${atualizacao.detalhe}). Toque para tentar de novo.`}
              </Alerta>
            </Pressable>
          ) : null}
          {resumo ? <Alerta tipo="ok">{resumo}</Alerta> : null}
          {erro ? <Alerta>{erro}</Alerta> : null}
          <Text style={estilos.titulo}>Atualizar cadastro</Text>
          <Text style={estilos.texto}>Leia o código de barras do produto. Se ele já estiver cadastrado, a câmera abre para as fotos; se não, você cadastra na hora.</Text>
          {Platform.OS !== 'web' ? (
            <Botao titulo="📷 Ler código com a câmera" disabled={tela.qual === 'buscando'} onPress={() => void temCamera().then((ok) => ok && setTela({ qual: 'camera-codigo' }))} />
          ) : null}
          <Text style={[estilos.rotulo, { marginTop: 20 }]}>Ou digite o código</Text>
          <View style={estilos.linha}>
            <TextInput
              accessibilityLabel="Código de barras"
              style={[estilos.campo, { flex: 1 }]}
              value={digitado}
              onChangeText={setDigitado}
              keyboardType="number-pad"
              returnKeyType="search"
              maxLength={20}
              placeholder="7891234567895"
              placeholderTextColor="#94a3b8"
              onSubmitEditing={() => void buscar(digitado, false)}
            />
            <View style={{ width: 110 }}>
              <Botao titulo="Buscar" variante="secundario" ocupado={tela.qual === 'buscando'} disabled={!digitado.trim()} onPress={() => void buscar(digitado, false)} />
            </View>
          </View>
          {tela.qual === 'buscando' ? <Text style={estilos.ajuda}>Buscando {tela.codigo}…</Text> : null}
          <Text style={[estilos.ajuda, { marginTop: 24 }]}>Versão {versaoInstalada()}</Text>
        </ScrollView>
      )}
    </View>
  );
}

const estilos = StyleSheet.create({
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  topo: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: cores.borda, backgroundColor: cores.branco },
  marca: { fontSize: 18, fontWeight: '700', color: cores.marca },
  usuario: { fontSize: 12, color: cores.suave },
  sair: { fontSize: 15, color: cores.suave, fontWeight: '600' },
  pagina: { padding: 16, flexGrow: 1 },
  titulo: { fontSize: 22, fontWeight: '700', color: cores.texto, marginBottom: 6 },
  texto: { fontSize: 15, color: cores.texto, lineHeight: 22, marginBottom: 16 },
  rotulo: { fontSize: 14, color: cores.texto, fontWeight: '600', marginBottom: 4 },
  linha: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  campo: { minHeight: 48, borderWidth: 1, borderColor: cores.borda, borderRadius: 8, backgroundColor: cores.branco, paddingHorizontal: 12, fontSize: 18, color: cores.texto, letterSpacing: 1 },
  ajuda: { fontSize: 13, color: cores.suave, marginTop: 8 },
});
