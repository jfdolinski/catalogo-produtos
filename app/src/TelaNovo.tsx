import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ErroApi, type Api, type Produto } from './api';
import { sugestoesUteis, type Sugestao } from './regras';
import { CampoSugestao } from './CampoSugestao';
import { Alerta, Botao, Cartao, cores } from './ui';

const mensagem = (e: unknown) => (e instanceof ErroApi ? e.message : 'Algo deu errado. Tente de novo.');

/**
 * Código sem cadastro: mostra o que as bases públicas sabem do código (as mesmas da fila de atualização),
 * o usuário confirma ou digita o nome e cadastra. Depois segue para as fotos.
 */
export function TelaNovo({ api, codigo, aoCadastrar, aoVoltar }: { api: Api; codigo: string; aoCadastrar: (p: Produto) => void; aoVoltar: () => void }) {
  const [sugestoes, setSugestoes] = useState<Sugestao[] | null>(null);
  const [cosmos, setCosmos] = useState<'nao' | 'pode' | 'buscando'>('nao');
  const [nome, setNome] = useState('');
  const [marca, setMarca] = useState('');
  const [categoria, setCategoria] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    let vivo = true;
    api
      .sugestoes(codigo)
      .then((r) => {
        if (!vivo) return;
        setSugestoes(sugestoesUteis(r.results));
        if (r.cosmos_available && r.results.some((x) => x.source === 'cosmos' && x.skipped)) setCosmos('pode');
      })
      .catch((e) => vivo && (setSugestoes([]), setErro(mensagem(e))));
    return () => {
      vivo = false;
    };
  }, [api, codigo]);

  async function consultarCosmos() {
    setCosmos('buscando');
    try {
      const r = await api.sugestoes(codigo, 'only');
      setSugestoes((s) => sugestoesUteis([...r.results, ...(s ?? [])]));
      setCosmos('nao');
    } catch (e) {
      setErro(mensagem(e));
      setCosmos('pode');
    }
  }

  function usar(s: Sugestao) {
    setNome(s.name ?? '');
    setMarca(s.brand ?? '');
    setCategoria(s.category ?? '');
  }

  async function cadastrar() {
    if (!nome.trim()) return setErro('Informe o nome do produto.');
    setErro(null);
    setEnviando(true);
    try {
      aoCadastrar(await api.cadastrar({ name: nome.trim(), brand: marca.trim(), category: categoria.trim() }, codigo));
    } catch (e) {
      setErro(mensagem(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={estilos.pagina} keyboardShouldPersistTaps="handled">
      <Text style={estilos.titulo}>Produto não cadastrado</Text>
      <Text style={estilos.codigo}>{codigo}</Text>
      {erro ? <Alerta>{erro}</Alerta> : null}

      <Cartao>
        <Text style={estilos.secao}>O que as bases públicas sabem</Text>
        {sugestoes === null ? (
          <View style={estilos.linha}><ActivityIndicator color={cores.marca} /><Text style={estilos.ajuda}>Buscando o código…</Text></View>
        ) : sugestoes.length ? (
          sugestoes.map((s, i) => (
            <View key={`${s.source}-${i}`} style={estilos.sugestao}>
              {s.images?.[0] ? <Image source={{ uri: s.images[0] }} style={estilos.miniatura} /> : <View style={[estilos.miniatura, estilos.semFoto]}><Text style={estilos.ajuda}>sem foto</Text></View>}
              <View style={{ flex: 1 }}>
                <Text style={estilos.fonte}>{s.source_name}</Text>
                <Text style={estilos.nome}>{s.name}</Text>
                {s.brand || s.category ? <Text style={estilos.ajuda}>{[s.brand, s.category].filter(Boolean).join(' · ')}</Text> : null}
                <Botao titulo="Usar estes dados" variante="secundario" onPress={() => usar(s)} />
              </View>
            </View>
          ))
        ) : (
          <Text style={estilos.ajuda}>Nenhuma base conhece este código. Digite o nome do produto abaixo.</Text>
        )}
        {cosmos !== 'nao' ? (
          <>
            <Botao titulo="🔎 Consultar na Cosmos" variante="secundario" ocupado={cosmos === 'buscando'} onPress={() => void consultarCosmos()} />
            <Text style={estilos.ajuda}>Usa 1 consulta da franquia diária; a resposta fica guardada.</Text>
          </>
        ) : null}
      </Cartao>

      <Cartao>
        <Text style={estilos.rotulo}>Nome *</Text>
        <TextInput accessibilityLabel="Nome" style={estilos.campo} value={nome} onChangeText={setNome} autoCapitalize="sentences" maxLength={300} multiline />
        <CampoSugestao api={api} campo="brand" rotulo="Marca" valor={marca} aoMudar={setMarca} />
        <CampoSugestao api={api} campo="category" rotulo="Categoria" valor={categoria} aoMudar={setCategoria} />
        <Botao titulo="Cadastrar e tirar as fotos" ocupado={enviando} onPress={() => void cadastrar()} />
      </Cartao>
      <Botao titulo="Voltar sem cadastrar" variante="secundario" disabled={enviando} onPress={aoVoltar} />
    </ScrollView>
  );
}

const estilos = StyleSheet.create({
  pagina: { padding: 16, backgroundColor: cores.fundo, flexGrow: 1 },
  titulo: { fontSize: 20, fontWeight: '700', color: cores.texto },
  codigo: { fontSize: 16, color: cores.suave, marginTop: 2, marginBottom: 12 },
  secao: { fontSize: 16, fontWeight: '700', color: cores.texto, marginBottom: 10 },
  linha: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sugestao: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  miniatura: { width: 72, height: 72, borderRadius: 6, backgroundColor: cores.borda },
  semFoto: { alignItems: 'center', justifyContent: 'center' },
  fonte: { fontSize: 12, color: cores.suave },
  nome: { fontSize: 15, fontWeight: '600', color: cores.texto, marginVertical: 2 },
  ajuda: { fontSize: 13, color: cores.suave, marginVertical: 6 },
  rotulo: { fontSize: 14, color: cores.texto, fontWeight: '600', marginBottom: 4 },
  campo: { minHeight: 48, borderWidth: 1, borderColor: cores.borda, borderRadius: 8, backgroundColor: cores.branco, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: cores.texto, marginBottom: 12 },
});
